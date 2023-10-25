// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { StateChannel } from '@subql/network-query';
import { BigNumber, utils } from 'ethers';

import { AccountService } from 'src/core/account.service';
import { PaygEvent } from 'src/utils/subscription';
import { Repository } from 'typeorm';
import { ContractService } from '../core/contract.service';
import { getLogger } from '../utils/logger';
import { Channel, ChannelLabor, ChannelStatus } from './payg.model';
import { PaygQueryService } from './payg.query.service';
import { PaygService } from './payg.service';

const logger = getLogger('payg');

@Injectable()
export class PaygSyncService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(Channel) private channelRepo: Repository<Channel>,
    @InjectRepository(ChannelLabor) private laborRepo: Repository<ChannelLabor>,
    private contractService: ContractService,
    private paygQueryService: PaygQueryService,
    private paygService: PaygService,
    private account: AccountService
  ) {}

  private syncingStateChannels = false;

  onApplicationBootstrap() {
    void (() => {
      this.subscribeStateChannelEvents();
    })();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async syncStateChannelsPeriodically() {
    if (this.syncingStateChannels) {
      logger.debug(`Bypass syncing state channels...`);
      return;
    }
    this.syncingStateChannels = true;
    try {
      logger.debug(`Syncing state channels from Subquery Project...`);
      const hostIndexer = await this.account.getIndexer();
      if (!hostIndexer) {
        logger.debug(`Indexer not found, will sync state channel later...`);
        this.syncingStateChannels = false;
        return;
      }
      const stateChannels = await this.paygQueryService.getStateChannels(hostIndexer);
      const localAliveChannels = await this.paygService.getAliveChannels();

      const stateChannelIds = stateChannels.map((stateChannel) =>
        BigNumber.from(stateChannel.id).toString().toLowerCase()
      );
      const localAliveChannelIds = localAliveChannels.map((channel) => channel.id);

      const closedChannelIds = localAliveChannelIds.filter((id) => !stateChannelIds.includes(id));
      for (const id of closedChannelIds) {
        await this.paygService.syncChannel(id);
      }

      const mappedLocalAliveChannels: Record<string, Channel> = {};
      for (const channel of localAliveChannels) {
        mappedLocalAliveChannels[channel.id] = channel;
      }

      for (const stateChannel of stateChannels) {
        const id = BigNumber.from(stateChannel.id).toString().toLowerCase();
        if (this.compareChannel(mappedLocalAliveChannels[id], stateChannel)) {
          logger.debug(`State channel is up to date: ${id}`);
          continue;
        }
        await this.paygService.syncChannel(id);
      }

      logger.debug(`Synced state channels from Subquery Project`);
    } catch (e) {
      logger.error(`Failed to sync state channels from Subquery Project: ${e}`);
    }
    this.syncingStateChannels = false;
  }

  compareChannel(channel: Channel, channelState: StateChannel): boolean {
    const { status, agent, total, spent, price } = channelState;

    return (
      channel.status === status &&
      channel.agent === agent &&
      channel.total === total.toString() &&
      channel.spent === spent.toString() &&
      channel.price === price.toString()
    );
  }

  subscribeStateChannelEvents(): void {
    const contractSDK = this.contractService.getSdk();
    const stateChannel = contractSDK.stateChannel;

    stateChannel.on(
      'ChannelOpen',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      async (channelId, indexer, _consumer, total, price, expiredAt, deploymentId, callback) => {
        const hostIndexer = await this.account.getIndexer();
        if (indexer !== hostIndexer) return;

        let [agent, consumer] = ['', _consumer];
        try {
          consumer = utils.defaultAbiCoder.decode(['address'], callback)[0] as string;
          agent = consumer;
        } catch {
          logger.debug(`Channel created by user: ${consumer}`);
        }

        void this.syncOpen(channelId.toString(), consumer, agent, price.toString());
      }
    );

    stateChannel.on('ChannelExtend', (channelId, expiredAt) => {
      void this.syncExtend(channelId.toString(), expiredAt.toNumber());
    });

    stateChannel.on('ChannelFund', (channelId, total) => {
      void this.syncFund(channelId.toString(), total.toString());
    });

    stateChannel.on('ChannelCheckpoint', (channelId, spent) => {
      void this.syncCheckpoint(channelId.toString(), spent.toString());
    });

    stateChannel.on('ChannelTerminate', (channelId, spent, terminatedAt, terminateByIndexer) => {
      void this.syncTerminate(
        channelId.toString(),
        spent.toString(),
        terminatedAt.toNumber(),
        terminateByIndexer
      );
    });

    stateChannel.on('ChannelFinalize', (channelId, total, remain) => {
      void this.syncFinalize(channelId.toString(), total, remain);
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    stateChannel.on('ChannelLabor', async (deploymentId, indexer, amount) => {
      const chainLastBlock = await this.contractService.getLastBlockNumber();
      await this.syncLabor(deploymentId, indexer, amount.toString(), chainLastBlock);
    });
  }

  async syncOpen(id: string, consumer: string, agent: string, price: string) {
    const channel = await this.paygService.saveChannel(id, channelState, price, agent);
    if (!channel) return;

    channel.consumer = consumer;
    channel.agent = agent;
    channel.price = price;
    await this.paygService.savePub(channel, PaygEvent.Opened);
  }

  async syncExtend(id: string, expiredAt: number) {
    const channel = await this.paygService.channel(id);
    if (!channel) return;

    channel.expiredAt = expiredAt;
    channel.terminatedAt = expiredAt;
    await this.paygService.savePub(channel, PaygEvent.State);
  }

  async syncFund(id: string, total: string) {
    const channel = await this.paygService.channel(id);
    if (!channel) return;

    channel.total = total;
    await this.paygService.savePub(channel, PaygEvent.State);
  }

  async syncCheckpoint(id: string, onchain: string) {
    const channel = await this.paygService.channel(id);
    if (!channel) return;

    channel.onchain = onchain;
    await this.paygService.savePub(channel, PaygEvent.State);
  }

  async syncTerminate(id: string, onchain: string, terminatedAt: number, byIndexer: boolean) {
    const channel = await this.paygService.channel(id);
    if (!channel) return;

    channel.onchain = onchain;
    channel.status = ChannelStatus.TERMINATING;
    channel.terminatedAt = terminatedAt;
    channel.terminateByIndexer = byIndexer;
    channel.lastFinal = true;

    await this.paygService.savePub(channel, PaygEvent.State);
  }

  async syncFinalize(id: string, total: BigNumber, remain: BigNumber) {
    const channel = await this.paygService.channel(id);
    if (!channel) return;

    channel.onchain = total.sub(remain).toString();
    channel.status = ChannelStatus.FINALIZED;
    channel.lastFinal = true;

    await this.paygService.savePub(channel, PaygEvent.Stopped);
  }

  async syncLabor(deploymentId: string, indexer: string, total: string, createdAt: number) {
    const labor = this.laborRepo.create({
      deploymentId: deploymentId,
      indexer: indexer,
      total: total,
      createdAt: createdAt,
    });
    await this.laborRepo.save(labor);
  }
}

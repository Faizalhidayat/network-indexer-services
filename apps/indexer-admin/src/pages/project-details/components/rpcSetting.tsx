// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import React, { FC } from 'react';
import { useParams } from 'react-router';
import { useLazyQuery, useMutation, useQuery } from '@apollo/client';
import { Steps, Typography } from '@subql/components';
import { cidToBytes32 } from '@subql/network-clients';
import { Button, Form, Input } from 'antd';
import { merge } from 'lodash';

import Avatar from 'components/avatar';
import { useProjectDetails } from 'hooks/projectHook';
import { GET_RPC_ENDPOINT_KEYS, START_PROJECT, VALID_RPC_ENDPOINT } from 'utils/queries';

interface IProps {
  onSubmit: () => void;
  onCancel: () => void;
}

const RpcSetting: FC<IProps> = (props) => {
  const { onCancel, onSubmit } = props;
  const { id } = useParams() as { id: string };
  const projectQuery = useProjectDetails(id);
  const [form] = Form.useForm();

  const keys = useQuery<{ getRpcEndpointKeys: string[] }>(GET_RPC_ENDPOINT_KEYS, {
    variables: {
      projectId: id,
    },
  });

  const [validate] = useLazyQuery<
    { validateRpcEndpoint: { valid: boolean; reason?: string } },
    { projectId: string; endpointKey: string; endpoint: string }
  >(VALID_RPC_ENDPOINT);

  const [startProjectRequest] = useMutation(START_PROJECT);

  if (!projectQuery.data) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Steps
        steps={[
          {
            title: 'Deployment ID',
            status: 'finish',
          },
          {
            title: 'Deployment Settings',
            status: 'process',
          },
        ]}
      />

      <Typography style={{ marginTop: 24, marginBottom: 8 }}>Project Detail</Typography>

      <div
        style={{
          display: 'flex',
          borderRadius: 8,
          border: '1px solid var(--sq-gray300)',
          padding: 16,
          background: 'rgba(67, 136, 221, 0.05)',
          gap: 12,
        }}
      >
        <Avatar address={projectQuery.data?.project.details.image || cidToBytes32(id)} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Typography>{projectQuery.data?.project.details.name}</Typography>
          <Typography variant="small" type="secondary">
            RPC Service
          </Typography>
        </div>
      </div>

      <Typography style={{ marginTop: 24 }}>Please provide the connect settings.</Typography>

      <div style={{ margin: '16px 0' }}>
        <Form
          layout="vertical"
          form={form}
          initialValues={merge(
            {},
            ...projectQuery.data.project.projectConfig.serviceEndpoints.map((val) => {
              return {
                [`${val.key}Endpoint`]: val.value,
              };
            })
          )}
        >
          {keys.data?.getRpcEndpointKeys.map((key) => {
            return (
              <Form.Item
                key={key}
                label={`${key} Endpoint`}
                name={`${key}Endpoint`}
                hasFeedback
                rules={[
                  () => {
                    return {
                      validator: async (_, value) => {
                        if (!value) return Promise.reject(new Error('Please input http endpoint'));
                        const res = await validate({
                          variables: {
                            projectId: id,
                            endpoint: value,
                            endpointKey: `${key}Endpoint`,
                          },
                          defaultOptions: {
                            fetchPolicy: 'network-only',
                          },
                        });

                        if (!res?.data?.validateRpcEndpoint.valid) {
                          return Promise.reject(new Error(res?.data?.validateRpcEndpoint.reason));
                        }
                        // verification RPC endpoint
                        if (value) {
                          return Promise.resolve();
                        }

                        return Promise.reject(new Error('xxxx'));
                      },
                    };
                  },
                ]}
              >
                <Input />
              </Form.Item>
            );
          })}
        </Form>
      </div>
      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end' }}>
        <Button
          shape="round"
          onClick={() => {
            onCancel();
          }}
        >
          Back
        </Button>
        <Button
          shape="round"
          type="primary"
          style={{ borderColor: 'var(--sq-blue600)', background: 'var(--sq-blue600)' }}
          onClick={async () => {
            await form.validateFields();
            const serviceEndpoints = keys.data?.getRpcEndpointKeys.map((key) => {
              return {
                key,
                value: form.getFieldValue(`${key}Endpoint`),
              };
            });
            await startProjectRequest({
              variables: {
                poiEnabled: false,
                queryVersion: '',
                nodeVersion: '',
                networkDictionary: '',
                networkEndpoints: '',
                batchSize: 1,
                workers: 1,
                timeout: 1,
                cache: 1,
                cpu: 1,
                memory: 1,
                id,
                projectType: projectQuery.data?.project.projectType,
                serviceEndpoints,
              },
            });
            onSubmit();
          }}
        >
          Update
        </Button>
      </div>
    </div>
  );
};
export default RpcSetting;

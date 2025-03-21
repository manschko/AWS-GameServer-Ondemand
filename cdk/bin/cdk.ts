#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GameStack } from '../lib/game-stack';
import { DomainStack } from '../lib/domain-stack';
import { resolveConfig } from '../lib/config';

const app = new cdk.App();

const config = resolveConfig();

if (!config.domainName) {
  throw new Error('Missing required `DOMAIN_NAME` in .env file, please rename\
    `.env.sample` to `.env` and add your domain name.');
}

const domainStack = new DomainStack(app, `${process.env.GAME_NAME}-domain-stack`, {
  env: {
    /**
     * Because we are relying on Route 53+CloudWatch to invoke the Lambda function,
     * it _must_ reside in the N. Virginia (us-east-1) region.
     */
    region: 'us-east-1',
    /* Account must be specified to allow for hosted zone lookup */
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  config,
});

const minecraftStack = new GameStack(app, `${process.env.GAME_NAME}-server-stack`, {
  env: {
    region: config.serverRegion,
    /* Account must be specified to allow for VPC lookup */
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  config,
});

minecraftStack.addDependency(domainStack);

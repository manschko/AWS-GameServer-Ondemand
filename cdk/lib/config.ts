import * as dotenv from 'dotenv';
import * as path from 'path';
import { ContainerImageEnv, StackConfig } from './types';
import { stringAsBoolean } from './util';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const resolveContainerEnvVars = (json = ''): ContainerImageEnv => {
  const defaults = { EULA: 'TRUE' };
  try {
    return {
      ...defaults,
      ...JSON.parse(json),
    };
  } catch (e) {
    console.error(
      'Unable to resolve .env value for CONTAINER_IMAGE_ENV_VARS_JSON.\
      Defaults will be used'
    );
    return defaults;
  }
};

export const resolveConfig = (): StackConfig => ({
  domainName: process.env.DOMAIN_NAME || '',
  subdomainPart: process.env.SUBDOMAIN_PART || '',
  serverRegion: process.env.SERVER_REGION || 'us-east-1',
  shutdownMinutes: process.env.SHUTDOWN_MINUTES || '20',
  startupMinutes: process.env.STARTUP_MINUTES || '10',
  useFargateSpot: stringAsBoolean(process.env.USE_FARGATE_SPOT) || false,
  taskCpu: +(process.env.TASK_CPU || 1)*1024,
  taskMemory: +(process.env.TASK_MEMORY || 2)*1024,
  vpcId: process.env.VPC_ID || '',
  containerImageEnv: resolveContainerEnvVars(
    process.env.CONTAINER_IMAGE_ENV_VARS_JSON
  ),
  snsEmailAddress: process.env.SNS_EMAIL_ADDRESS || '',
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  twilio: {
    phoneFrom: process.env.TWILIO_PHONE_FROM || '',
    phoneTo: process.env.TWILIO_PHONE_TO || '',
    accountId: process.env.TWILIO_ACCOUNT_ID || '',
    authCode: process.env.TWILIO_AUTH_CODE || '',
  },
  debug: stringAsBoolean(process.env.DEBUG) || false,
  udpPorts: process.env.UDP_PORTS && process.env.UDP_PORTS.split(",") ||[],
  tcpPorts: process.env.TCP_PORTS && process.env.TCP_PORTS.split(",") ||[],
  customCheckCommand: process.env.CUSTOM_CHECK_COMMAND || '',
  gameName: process.env.GAME_NAME|| '',
  ecsVolumeName: process.env.ECS_VOLUME_NAME ||'data',
  gameServerImage: process.env.GAME_IMAGE ||''
});

import * as path from 'path';
import {
    Stack,
    StackProps,
    aws_lambda as lambda,
    aws_ec2 as ec2,
    aws_efs as efs,
    aws_iam as iam,
    aws_ecs as ecs,
    aws_logs as logs,
    aws_sns as sns,
    RemovalPolicy,
    Arn,
    ArnFormat,
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {SSMParameterReader} from './ssm-parameter-reader';
import {StackConfig} from './types';
import {isDockerInstalled, isLocalDockerfilePath} from './util';
import { Port } from 'aws-cdk-lib/aws-ec2';

interface GameStackProps extends StackProps {
    config: Readonly<StackConfig>;
}

export class GameStack extends Stack {
    constructor(scope: Construct, id: string, props: GameStackProps) {
        super(scope, id, props);

        const {config} = props;

        const vpc = config.vpcId
            ? ec2.Vpc.fromLookup(this, 'Vpc', {vpcId: config.vpcId})
            : new ec2.Vpc(this, 'Vpc', {
                maxAzs: 3,
                natGateways: 0,
            });

        const fileSystem = new efs.FileSystem(this, 'FileSystem', {
            vpc,
            removalPolicy: RemovalPolicy.SNAPSHOT,
        });

        const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
            fileSystem,
            path: `/${config.subdomainPart}`,
            posixUser: {
                uid: '1000',
                gid: '1000',
            },
            createAcl: {
                ownerGid: '1000',
                ownerUid: '1000',
                permissions: '0755',
            },
        });

        const efsReadWriteDataPolicy = new iam.Policy(this, 'DataRWPolicy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowReadWriteOnEFS',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'elasticfilesystem:ClientMount',
                        'elasticfilesystem:ClientWrite',
                        'elasticfilesystem:DescribeFileSystems',
                    ],
                    resources: [fileSystem.fileSystemArn],
                    conditions: {
                        StringEquals: {
                            'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
                        },
                    },
                }),
            ],
        });

        const ecsTaskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: `${config.subdomainPart} ECS task role`,
        });

        efsReadWriteDataPolicy.attachToRole(ecsTaskRole);

        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: config.gameName,
            vpc,
            containerInsights: true, // TODO: Add config for container insights
            enableFargateCapacityProviders: true,
        });

        const taskDefinition = new ecs.FargateTaskDefinition(
            this,
            'TaskDefinition',
            {
                taskRole: ecsTaskRole,
                memoryLimitMiB: config.taskMemory,
                cpu: config.taskCpu,
                volumes: [
                    {
                        name: `${config.gameName}-data`,
                        efsVolumeConfiguration: {
                            fileSystemId: fileSystem.fileSystemId,
                            transitEncryption: 'ENABLED',
                            authorizationConfig: {
                                accessPointId: accessPoint.accessPointId,
                                iam: 'ENABLED',
                            },
                        },
                    },
                ],
            }
        );

        // Create port mappings from the game server configuration
        const portMappings: ecs.PortMapping[] = [];
        
        // Add TCP ports
        if (config.tcpPorts?.length) {
            config.tcpPorts.forEach(port => {
                portMappings.push({
                    containerPort: parseInt(port),
                    hostPort: parseInt(port),
                    protocol: ecs.Protocol.TCP
                });
            });
        }
        
        // Add UDP ports
        if (config.udpPorts?.length) {
            config.udpPorts.forEach(port => {
                portMappings.push({
                    containerPort: parseInt(port),
                    hostPort: parseInt(port),
                    protocol: ecs.Protocol.UDP
                });
            });
        }

        const gameServerContainer = new ecs.ContainerDefinition(
            this,
            'GameServerContainer',
            {
              containerName: `${config.gameName}-server`, 
              image: !isLocalDockerfilePath(config.gameServerImage)
                ? ecs.ContainerImage.fromRegistry(config.gameServerImage)
                : ecs.ContainerImage.fromAsset(config.gameServerImage),
              portMappings: portMappings,
              environment: config.containerImageEnv || {},
              essential: false,
              taskDefinition,
              logging: config.debug
                ? new ecs.AwsLogDriver({
                    logRetention: logs.RetentionDays.THREE_DAYS,
                    streamPrefix: `${config.gameName}-server`,
                  })
                : undefined,
            }
          );
          
          gameServerContainer.addMountPoints({
            containerPath: config.ecsVolumeName,
            sourceVolume: `${config.gameName}-data`,
            readOnly: false,
          });

        const serviceSecurityGroup = new ec2.SecurityGroup(
            this,
            'ServiceSecurityGroup',
            {
                vpc,
                description: `Security group for ${config.subdomainPart} on-demand`,
            }
        );

        // Add all TCP ports to security group
        if (config.tcpPorts?.length) {
            config.tcpPorts.forEach(port => {
                serviceSecurityGroup.addIngressRule(
                    ec2.Peer.anyIpv4(),
                    ec2.Port.tcp(parseInt(port)),
                    `Allow ${config.subdomainPart} TCP port ${port}`
                );
            });
        }
        
        // Add all UDP ports to security group
        if (config.udpPorts?.length) {
            config.udpPorts.forEach(port => {
                serviceSecurityGroup.addIngressRule(
                    ec2.Peer.anyIpv4(),
                    ec2.Port.udp(parseInt(port)),
                    `Allow ${config.subdomainPart} UDP port ${port}`
                );
            });
        }

        const gameServerService = new ecs.FargateService(
            this,
            'FargateService',
            {
                cluster,
                capacityProviderStrategies: [
                    {
                        capacityProvider: config.useFargateSpot
                            ? 'FARGATE_SPOT'
                            : 'FARGATE',
                        weight: 1,
                        base: 1,
                    },
                ],
                taskDefinition: taskDefinition,
                platformVersion: ecs.FargatePlatformVersion.LATEST,
                serviceName: `${config.gameName}-server`,
                desiredCount: 0,
                assignPublicIp: true,
                securityGroups: [serviceSecurityGroup],
            }
        );

        /* Allow access to EFS from Fargate service security group */
        fileSystem.connections.allowDefaultPortFrom(
            gameServerService.connections
        );



        const hostedZoneId = new SSMParameterReader(
            this,
            'Route53HostedZoneIdReader',
            {
                parameterName: `${config.gameName}HostedZoneID`,
                region: 'us-east-1',
            }
        ).getParameterValue();

        let snsTopicArn = '';
        /* Create SNS Topic if SNS_EMAIL is provided */
        if (config.snsEmailAddress) {
            const snsTopic = new sns.Topic(this, 'ServerSnsTopic', {
                displayName: `${config.subdomainPart} Server Notifications`,
            });

            snsTopic.grantPublish(ecsTaskRole);

            if (config.snsEmailAddress) {
                const emailSubscription = new sns.Subscription(
                    this,
                    'EmailSubscription',
                    {
                        protocol: sns.SubscriptionProtocol.EMAIL,
                        topic: snsTopic,
                        endpoint: config.snsEmailAddress,
                    }
                );
            }
            snsTopicArn = snsTopic.topicArn;

        }

        const watchdogContainer = new ecs.ContainerDefinition(
            this,
            'WatchDogContainer',
            {
                containerName: `${config.gameName}-ecsfargate-watchdog`,
                image: isDockerInstalled()
                    ? ecs.ContainerImage.fromAsset(
                        path.resolve(__dirname, '../../ecsfargate-watchdog/')
                    )
                    : ecs.ContainerImage.fromRegistry(
                        'doctorray/ecsfargate-watchdog'
                    ),
                essential: true,
                taskDefinition: taskDefinition,
                environment: {
                    CLUSTER: config.gameName,
                    SERVICE: `${config.gameName}-server`,
                    DNSZONE: hostedZoneId,
                    SERVERNAME: `${config.subdomainPart}.${config.domainName}`,
                    SNSTOPIC: snsTopicArn,
                    TWILIOFROM: config.twilio.phoneFrom,
                    TWILIOTO: config.twilio.phoneTo,
                    TWILIOAID: config.twilio.accountId,
                    TWILIOAUTH: config.twilio.authCode,
                    STARTUPMIN: config.startupMinutes,
                    SHUTDOWNMIN: config.shutdownMinutes,
                    GAME_TCP_PORTS: config.tcpPorts ? config.tcpPorts.join(',') : '',
                    GAME_UDP_PORTS: config.udpPorts ? config.udpPorts.join(',') : '',
                    CUSTOM_CHECK_COMMAND: config.customCheckCommand,
                    DISCORD_WEBHOOK: config.discordWebhook
                },
                logging: config.debug
                    ? new ecs.AwsLogDriver({
                        logRetention: logs.RetentionDays.THREE_DAYS,
                        streamPrefix: `${config.gameName}-ecsfargate-watchdog`,
                    })
                    : undefined,
            }
        );

        const serviceControlPolicy = new iam.Policy(this, 'ServiceControlPolicy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowAllOnServiceAndTask',
                    effect: iam.Effect.ALLOW,
                    actions: ['ecs:*'],
                    resources: [
                        gameServerService.serviceArn,
                        /* arn:aws:ecs:<region>:<account_number>:task/minecraft/* */
                        Arn.format(
                            {
                                service: 'ecs',
                                resource: 'task',
                                resourceName: `${config.gameName}/*`,
                                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                            },
                            this
                        ),
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['ec2:DescribeNetworkInterfaces'],
                    resources: ['*'],
                }),
            ],
        });

        serviceControlPolicy.attachToRole(ecsTaskRole);

        /**
         * Add service control policy to the launcher lambda from the other stack
         */
        const launcherLambdaRoleArn = new SSMParameterReader(
            this,
            'launcherLambdaRoleArn',
            {
                parameterName: 'LauncherLambdaRoleArn',
                region: 'us-east-1',
            }
        ).getParameterValue();
        const launcherLambdaRole = iam.Role.fromRoleArn(
            this,
            'LauncherLambdaRole',
            launcherLambdaRoleArn
        );
        serviceControlPolicy.attachToRole(launcherLambdaRole);

        /**
         * This policy gives permission to our ECS task to update the A record
         * associated with our minecraft server. Retrieve the hosted zone identifier
         * from Route 53 and place it in the Resource line within this policy.
         */
        const iamRoute53Policy = new iam.Policy(this, 'IamRoute53Policy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowEditRecordSets',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'route53:GetHostedZone',
                        'route53:ChangeResourceRecordSets',
                        'route53:ListResourceRecordSets',
                    ],
                    resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`],
                }),
            ],
        });
        iamRoute53Policy.attachToRole(ecsTaskRole);
    }
}

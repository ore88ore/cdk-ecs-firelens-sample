import { Construct } from "constructs";
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elb,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_assets as assets,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { FirelensLogRouterType } from "aws-cdk-lib/aws-ecs";
import { Effect } from "aws-cdk-lib/aws-iam";
import * as path from "path";
import * as firehose from "@aws-cdk/aws-kinesisfirehose-alpha";
import * as destinations from "@aws-cdk/aws-kinesisfirehose-destinations-alpha";

export class CdkEcsFirelensStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // アセット
    const asset = new assets.Asset(this, "asset", {
      path: path.join(__dirname, "extra.conf"),
    });

    // Firehose
    const logBucket = new s3.Bucket(this, "logBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new firehose.DeliveryStream(this, "logDeliveryStream", {
      deliveryStreamName: "log-delivery-stream",
      destinations: [new destinations.S3Bucket(logBucket)],
    });

    // VPC
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0 });

    // セキュリティグループ
    const albSecurityGroup = new ec2.SecurityGroup(this, "albSecurityGroup", {
      vpc,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.tcp(80)
    );
    const fargateSecurityGroup = new ec2.SecurityGroup(
      this,
      "fargateSecurityGroup",
      {
        vpc,
      }
    );
    fargateSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.allTraffic()
    );

    // ALB
    const alb = new elb.ApplicationLoadBalancer(this, "alb", {
      vpc,
      securityGroup: albSecurityGroup,
      internetFacing: true,
    });
    const listener = alb.addListener("listener", {
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
    });
    const targetGroup = new elb.ApplicationTargetGroup(this, "targetGroup", {
      vpc: vpc,
      port: 80,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      healthCheck: {
        path: "/",
        healthyHttpCodes: "200",
      },
    });
    listener.addTargetGroups("addTargetGroup", {
      targetGroups: [targetGroup],
    });

    // ECS
    const cluster = new ecs.Cluster(this, "cluster", { vpc });
    const taskRole = new iam.Role(this, "taskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogStream",
          "logs:CreateLogGroup",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
          "s3:GetObject",
          "s3:GetBucketLocation",
          "firehose:PutRecordBatch",
        ],
        resources: ["*"],
        effect: Effect.ALLOW,
      })
    );
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "taskDefinition",
      {
        cpu: 512,
        memoryLimitMiB: 1024,
        taskRole: taskRole,
      }
    );
    taskDefinition.addFirelensLogRouter("firelensLogRouter", {
      firelensConfig: {
        type: FirelensLogRouterType.FLUENTBIT,
      },
      environment: {
        aws_fluent_bit_init_s3_1: `arn:aws:s3:::${asset.s3BucketName}/${asset.s3ObjectKey}`,
      },
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/aws-observability/aws-for-fluent-bit:init-latest"
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "log-router",
      }),
    });

    taskDefinition.defaultContainer = taskDefinition.addContainer(
      "nginxContainer",
      {
        image: ecs.ContainerImage.fromRegistry(
          "public.ecr.aws/nginx/nginx:latest"
        ),
        logging: ecs.LogDrivers.firelens({
          options: {},
        }),
        portMappings: [{ containerPort: 80 }],
      }
    );

    const fargateService = new ecs.FargateService(this, "fargateService", {
      cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [fargateSecurityGroup],
    });
    fargateService.attachToApplicationTargetGroup(targetGroup);
  }
}

import { Port } from 'aws-cdk-lib/aws-ec2';
import { Protocol } from 'aws-cdk-lib/aws-ecs';
import * as execa from 'execa';
import { MinecraftEditionConfig, StackConfig } from './types';
import fs = require('fs');
import path = require('path');

export const stringAsBoolean = (str?: string): boolean =>
  Boolean(str === 'true');

export const isDockerInstalled = (): boolean => {
  try {
    execa.sync('docker', ['version']);
    return true;
  } catch (e) {
    return false;
  }
};

export const isLocalDockerfilePath = (imagePath:string) => {
  try {
    // Check if the path exists and contains a Dockerfile
    const resolvedPath = path.resolve(imagePath);
    return fs.existsSync(resolvedPath) && 
            (fs.existsSync(path.join(resolvedPath, 'Dockerfile')));
  } catch (error) {
    console.warn(`Error checking path ${imagePath}:`, error);
    return false;
  }
}
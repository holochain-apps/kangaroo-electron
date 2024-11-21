import path from 'path';
import fs from 'fs';
import semver from 'semver';
import { v4 as uuidv4 } from 'uuid';

export type Profile = string;


export class KangarooFileSystem {
  public appDataDir: string;
  public appConfigDir: string;
  public appLogsDir: string;

  public conductorDir: string;
  public keystoreDir: string;

  constructor(appDataDir: string, appConfigDir: string, appLogsDir: string) {
    this.appDataDir = appDataDir;
    this.appConfigDir = appConfigDir;
    this.appLogsDir = appLogsDir;

    this.conductorDir = path.join(appDataDir, 'conductor');
    this.keystoreDir = path.join(appDataDir, 'keystore');

    createDirIfNotExists(this.conductorDir);
    createDirIfNotExists(this.keystoreDir);
  }

  static connect(app: Electron.App, profile?: Profile, tempDir?: string) {
    profile = profile ? profile : 'default';
    const versionString = breakingAppVersion(app);

    const defaultLogsPath = app.getPath('logs');
    console.log('defaultLogsPath: ', defaultLogsPath);

    const defaultUserDataPath = app.getPath('userData');
    console.log('defaultUserDataPath: ', defaultUserDataPath);
    // check whether userData path has already been modified, otherwise, set paths to point
    // to the profile-specific paths
    if (!defaultUserDataPath.endsWith(profile)) {
      const rootDir = tempDir ? tempDir : defaultUserDataPath;

      app.setPath('logs', path.join(rootDir, versionString, profile, 'logs'));
      app.setAppLogsPath(path.join(rootDir, versionString, profile, 'logs'));
      app.setPath('userData', path.join(rootDir, versionString, profile));
      app.setPath('sessionData', path.join(rootDir, versionString, profile, 'chromium'));
      fs.rmdirSync(defaultLogsPath);
    }

    const logsDir = app.getPath('logs');
    const configDir = path.join(app.getPath('userData'), 'config');
    const dataDir = path.join(app.getPath('userData'), 'data');

    createDirIfNotExists(logsDir);
    createDirIfNotExists(configDir);
    createDirIfNotExists(dataDir);

    console.log('Got logsDir, configDir and dataDir: ', logsDir, configDir, dataDir);

    const kangarooFs = new KangarooFileSystem(dataDir, configDir, logsDir);

    return kangarooFs;
  }

  get conductorConfigPath() {
    return path.join(this.conductorDir, 'conductor-config.yaml');
  }

  keystoreInitialized = () => {
    return fs.existsSync(path.join(this.keystoreDir, 'lair-keystore-config.yaml'));
  };

  readOrCreatePassword() {
    const pwPath = path.join(this.appDataDir, '.pw');
    if (!fs.existsSync(pwPath)) {
      const pw = uuidv4();
      fs.writeFileSync(pwPath, pw, 'utf-8');
    }
    return fs.readFileSync(pwPath, 'utf-8');
  }

}

function createDirIfNotExists(path: fs.PathLike) {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path, { recursive: true });
  }
}


export function breakingAppVersion(app: Electron.App): string {
  const version = app.getVersion();
  if (!semver.valid(version)) {
    throw new Error('App has an invalid version number.');
  }
  const prerelease = semver.prerelease(version);
  if (prerelease) {
    return `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}-${prerelease[0]}`;
  }
  switch (semver.major(version)) {
    case 0:
      switch (semver.minor(version)) {
        case 0:
          return `0.0.${semver.patch(version)}`;
        default:
          return `0.${semver.minor(version)}.x`;
      }
    default:
      return `${semver.major(version)}.x.x`;
  }
}

/* eslint-disable @typescript-eslint/no-var-requires */
import getPort from "get-port";
import fs from "fs";
import * as childProcess from "child_process";
import { HolochainVersion, KangarooEmitter } from "./eventEmitter";
import split from "split";
import {
  AdminWebsocket,
  AppAuthenticationToken,
  AppInfo,
} from "@holochain/client";
import { breakingAppVersion, KangarooFileSystem } from "./filesystem";
import { HAPP_APP_ID, HAPP_PATH, KANGAROO_CONFIG } from "./const";

const rustUtils = require("@lightningrodlabs/we-rust-utils");

export type AdminPort = number;
export type AppPort = number;

export class HolochainManager {
  processHandle: childProcess.ChildProcessWithoutNullStreams;
  adminPort: AdminPort;
  appPort: AppPort;
  adminWebsocket: AdminWebsocket;
  fs: KangarooFileSystem;
  installedApps: AppInfo[];
  kangarooEmitter: KangarooEmitter;
  version: HolochainVersion;
  appToken: AppAuthenticationToken | undefined;

  constructor(
    processHandle: childProcess.ChildProcessWithoutNullStreams,
    kangarooEmitter: KangarooEmitter,
    mossFileSystem: KangarooFileSystem,
    adminPort: AdminPort,
    appPort: AppPort,
    adminWebsocket: AdminWebsocket,
    installedApps: AppInfo[],
    version: HolochainVersion
  ) {
    this.processHandle = processHandle;
    this.kangarooEmitter = kangarooEmitter;
    this.adminPort = adminPort;
    this.appPort = appPort;
    this.adminWebsocket = adminWebsocket;
    this.fs = mossFileSystem;
    this.installedApps = installedApps;
    this.version = version;
  }

  static async launch(
    kangarooEmitter: KangarooEmitter,
    kangarooFs: KangarooFileSystem,
    binary: string,
    password: string,
    version: HolochainVersion,
    rootDir: string,
    configPath: string,
    lairUrl: string,
    bootstrapUrl: string,
    signalingUrl: string,
    rustLog?: string,
    wasmLog?: string
  ): Promise<HolochainManager> {
    const adminPort = process.env.ADMIN_PORT
      ? parseInt(process.env.ADMIN_PORT, 10)
      : await getPort();

    const conductorConfig = rustUtils.defaultConductorConfig(
      adminPort,
      rootDir,
      lairUrl,
      bootstrapUrl,
      signalingUrl,
      "*"
    );

    console.log("Writing conductor-config.yaml...");

    fs.writeFileSync(configPath, conductorConfig);

    const conductorHandle = childProcess.spawn(
      binary,
      ["-c", configPath, "-p"],
      {
        env: {
          RUST_LOG: rustLog
            ? rustLog
            : "warn," +
              // this thrashes on startup
              "wasmer_compiler_cranelift=error," +
              // this gives a bunch of warnings about how long db accesses are taking, tmi
              "holochain_sqlite::db::access=error," +
              // this gives a lot of "search_and_discover_peer_connect: no peers found, retrying after delay" messages on INFO
              "kitsune_p2p::spawn::actor::discover=error",
          WASM_LOG: wasmLog ? wasmLog : "warn",
          NO_COLOR: "1",
        },
      }
    );
    conductorHandle.stdin.write(password);
    conductorHandle.stdin.end();
    conductorHandle.stdout.pipe(split()).on("data", async (line: string) => {
      kangarooEmitter.emitHolochainLog({
        version,
        data: line,
      });
    });
    conductorHandle.stderr.pipe(split()).on("data", (line: string) => {
      kangarooEmitter.emitHolochainError({
        version,
        data: line,
      });
    });

    return new Promise((resolve, reject) => {
      conductorHandle.stderr.pipe(split()).on("data", async (line: string) => {
        if (line.includes("holochain had a problem and crashed")) {
          reject(
            `Holochain failed to start up and crashed. Check the logs for details (Help > Open Logs).`
          );
        }
      });
      conductorHandle.stdout.pipe(split()).on("data", async (line: string) => {
        if (
          line.includes("could not be parsed, because it is not valid YAML")
        ) {
          reject(
            `Holochain failed to start up and crashed. Check the logs for details (Help > Open Logs).`
          );
        }
        if (line.includes("Conductor ready.")) {
          const adminWebsocket = await AdminWebsocket.connect({
            url: new URL(`ws://127.0.0.1:${adminPort}`),
            wsClientOptions: {
              origin: "moss-admin-main",
            },
          });
          console.log("Connected to admin websocket.");
          const installedApps = await adminWebsocket.listApps({});
          const appInterfaces = await adminWebsocket.listAppInterfaces();
          console.log("Got appInterfaces: ", appInterfaces);
          let appPort;
          if (appInterfaces.length > 0) {
            appPort = appInterfaces[0].port;
          } else {
            const attachAppInterfaceResponse =
              await adminWebsocket.attachAppInterface({
                allowed_origins: "*",
              });
            console.log(
              "Attached app interface port: ",
              attachAppInterfaceResponse
            );
            appPort = attachAppInterfaceResponse.port;
          }
          resolve(
            new HolochainManager(
              conductorHandle,
              kangarooEmitter,
              kangarooFs,
              adminPort,
              appPort,
              adminWebsocket,
              installedApps,
              version
            )
          );
        }
      });
    });
  }

  async installHappIfNecessary(networkSeed?: string) {
    const installedApps = await this.adminWebsocket.listApps({});
    if (
      installedApps
        .map((appInfo) => appInfo.installed_app_id)
        .includes(HAPP_APP_ID)
    )
      return;
    if (!networkSeed) {
      networkSeed = `${KANGAROO_CONFIG.productName}-${breakingAppVersion()}`;
    }
    console.log(`Installing happ...`);
    const pubKey = await this.adminWebsocket.generateAgentPubKey();
    const appInfo = await this.adminWebsocket.installApp({
      agent_key: pubKey,
      installed_app_id: HAPP_APP_ID,
      membrane_proofs: {},
      path: HAPP_PATH,
      network_seed: networkSeed,
    });
    try {
      await this.adminWebsocket.enableApp({
        installed_app_id: appInfo.installed_app_id,
      });
      const installedApps = await this.adminWebsocket.listApps({});
      this.installedApps = installedApps;
      this.kangarooEmitter.emitHappInstalled();
    } catch (e) {
      throw new Error(
        `Failed to enable appstore: ${e}.\nIf you encounter this in dev mode your local bootstrap server may not be running or at a different port than the one specified.`
      );
    }
  }

  async getAppToken(): Promise<AppAuthenticationToken> {
    const token = this.appToken;
    if (token) return token;
    const response = await this.adminWebsocket.issueAppAuthenticationToken({
      installed_app_id: HAPP_APP_ID,
      single_use: false,
      expiry_seconds: 0,
    });
    this.appToken = response.token;
    return response.token;
  }
}

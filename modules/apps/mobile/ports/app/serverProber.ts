export interface ServerProbeResult {
  readonly serverId: string
  readonly config: unknown
}

export interface IServerProber {
  probe(configPath: string, preferredServerId?: string): Promise<ServerProbeResult>
}

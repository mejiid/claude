declare module 'ws' {
  import { EventEmitter } from 'node:events'

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3

    readyState: number
    send(data: string | Buffer | ArrayBuffer | ArrayBufferView, cb?: (err?: Error) => void): void
    close(code?: number, data?: string): void
    terminate(): void
    ping(data?: unknown): void
    on(event: 'message', listener: (data: Buffer | string, isBinary: boolean) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'pong', listener: (data: Buffer) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  export interface ServerOptions {
    host?: string
    port?: number
    noServer?: boolean
    maxPayload?: number
  }

  export class Server extends EventEmitter {
    constructor(options?: ServerOptions)
    close(cb?: (err?: Error) => void): void
  }

  export default WebSocket
}

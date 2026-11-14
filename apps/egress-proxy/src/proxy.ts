import { isIP } from "node:net";
import type { Socket, TCPSocketListener } from "bun";
import type { ProxyLogger } from "./logger.ts";
import { createProxyLogger } from "./logger.ts";
import { messageOf } from "./message-of.ts";
import {
  decideEgress,
  type EgressPolicy,
  type EgressResolver,
} from "./policy.ts";
import {
  type BodyFramer,
  createBodyFramer,
  headEnd,
  type ProxyRequest,
  parseRequestHead,
} from "./request.ts";
import { createResponseRewriter, type ResponseRewriter } from "./response.ts";
import {
  type ClientHelloCursor,
  MAX_CLIENT_HELLO_BYTES,
  parseClientHelloSni,
} from "./tls.ts";

/**
 * A forward proxy that speaks exactly two things: `CONNECT host:port` for
 * TLS, and absolute-form HTTP for the plaintext gateway. Everything else is
 * refused, because everything else is a way to be surprised.
 *
 * A CONNECT tunnel carries TLS and nothing else: the first bytes the client
 * sends through it must be a ClientHello whose server name is the authority
 * the proxy judged. On a shared CDN edge the authority alone binds nothing —
 * the same address serves every name behind it — so the name in the
 * handshake is what the allowlist is really held to.
 *
 * It is the only member of the worker network that can route off it, so the
 * allowlist it enforces is the whole of a worker's reachable world — and one
 * worker must not be able to take that route away from the others, which is
 * what the per-client cap and the head deadline are for.
 */

export const DEFAULT_PROXY_PORT = 3128;
const MAX_HEAD_BYTES = 16 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/**
 * The whole of one dispatch: the name lookup plus every connect attempt. It
 * bounds how long a client can hold its slot, which matters because the slot
 * is only returned once the dispatch settles — an OS resolver that never
 * answers would otherwise retire the slot for good.
 */
const DEFAULT_DISPATCH_TIMEOUT_MS = 20_000;
const DEFAULT_HEAD_TIMEOUT_MS = 15_000;
/**
 * How long a CONNECT client has, after `200`, to finish its ClientHello.
 * Past its request head nothing else reaps a connection, so a client that
 * takes the tunnel and never speaks would otherwise hold its slot for good.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * How long a peer may leave a queue over its cap before the pair is dropped.
 * Pausing the fast side answers a peer that is merely slow; this answers one
 * that has stopped reading altogether, which nothing else reaps once the
 * connection is past its head.
 */
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_CONNECTIONS_PER_CLIENT = 32;
/** A destination resolving to more addresses than this is not tried further. */
const MAX_CONNECT_ATTEMPTS = 4;

export type EgressProxyOptions = {
  connectTimeoutMs?: number;
  /** The budget for one request's lookup and connect attempts together. */
  dispatchTimeoutMs?: number;
  /** How long a client may take to finish its request head. */
  headTimeoutMs?: number;
  /** How long a CONNECT client may take to finish its TLS ClientHello. */
  handshakeTimeoutMs?: number;
  hostname?: string;
  logger?: ProxyLogger;
  /** Bytes a slow peer may leave queued before the proxy stops reading. */
  maxBufferedBytes?: number;
  maxConnections?: number;
  maxConnectionsPerClient?: number;
  policy: EgressPolicy;
  port?: number;
  /** Reported on `/healthz` and at start; see `sourceDigest`. */
  sourceDigest?: string;
  /** How long a queue may stay over `maxBufferedBytes` before the drop. */
  stallTimeoutMs?: number;
  /** Injected by tests; production dials with Bun. */
  connect?: UpstreamDialer;
  /** Injected by tests; production resolves through the OS. */
  resolve?: EgressResolver;
};

export type EgressProxyServer = {
  readonly port: number;
  stop(): void;
};

type Queue = { bytes: number; chunks: Uint8Array[] };

/**
 * Bun's TCP sockets stop and restart reading at runtime — the peer then sees
 * TCP backpressure instead of this process buffering — but `bun-types` only
 * declares it on WebSocket, so the cast lives here rather than at four call
 * sites.
 *
 * ponytail: a hand-written declaration of someone else's API, verified
 * against Bun 1.3.11. Delete it the moment `bun-types` carries `pause` and
 * `resume` on `Socket`; if a Bun upgrade ever drops them, the proxy would
 * buffer without limit, so `a client that stops reading is dropped` is the
 * test that has to stay green.
 */
type SocketReader = { pause(): boolean; resume(): boolean };

function reader(socket: Socket<never> | Socket<unknown>): SocketReader {
  return socket as unknown as SocketReader;
}

/** The one thing a test needs to hold open: how an upstream is dialled. */
type UpstreamDialer = (options: {
  hostname: string;
  port: number;
  socket: NonNullable<Parameters<typeof Bun.connect<undefined>>[0]>["socket"];
}) => Promise<Socket<undefined>>;

/**
 * One dialled address. Until `adopt` names it the tunnel's upstream, its
 * handlers touch nothing on the client: what the upstream sends first is
 * held here, and a hold past the cap only pauses this socket. The client's
 * queues and stall timer belong to the attempt that won, and to it alone.
 */
type UpstreamAttempt = {
  socket: Socket<undefined>;
  /** Wires the attempt into the client and delivers what it held. */
  adopt(): void;
  /** Discards what it held and closes it; the client never hears of it. */
  abandon(): void;
};

type ClientState = {
  /**
   * A forwarded request's body, counted so nothing past it reaches the
   * upstream; null for a tunnel, whose bytes are TLS.
   */
  body: BodyFramer | null;
  buffer: Uint8Array;
  /** Bytes past the request have been seen, and said so once. */
  discarding: boolean;
  /** The upstream is done; end the client once its queue has drained. */
  closeWhenDrained: boolean;
  /**
   * The exchange is over and the connection is kept; read the next request
   * once the client has been written everything it is owed.
   */
  reuseWhenDrained: boolean;
  /** The forwarded request in flight asked to keep the connection. */
  keepAlive: boolean;
  /** An exchange has finished on this connection and it was kept. */
  reused: boolean;
  /** Still counted against the connection caps. */
  counted: boolean;
  /** An outbound attempt for this client is in flight. */
  dispatching: boolean;
  /** The client went away mid-dispatch; free its slot once that finishes. */
  releaseDeferred: boolean;
  /**
   * Read from the client before the tunnel was open: while the upstream
   * connection was still opening, and then while the ClientHello was being
   * judged. Nothing here reaches the upstream until that verdict.
   */
  early: Uint8Array[];
  earlyBytes: number;
  headTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The ClientHello as received so far, in one buffer sized to the cap, so
   * that a client dripping it a byte at a time costs one copy per byte and
   * not a fresh copy of everything before it.
   */
  hello: Uint8Array | null;
  helloBytes: number;
  /** Where the last incomplete parse stopped, so no record is walked twice. */
  helloCursor: ClientHelloCursor | undefined;
  /** Armed while a CONNECT client owes us its ClientHello. */
  helloTimer: ReturnType<typeof setTimeout> | undefined;
  phase: "head" | "connecting" | "inspecting" | "piping" | "closed";
  /** The CONNECT authority the ClientHello's server name is held to. */
  tunnelHost: string | null;
  remote: string;
  /** Armed while a queue sits over its cap; a peer that never drains dies. */
  stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Queue depth when the current deadline was armed, to measure progress. */
  stallBytes: number;
  /** Bytes owed to the client; flushed from the client's own drain. */
  toClient: Queue;
  /** Bytes owed to the upstream; flushed from the upstream's drain. */
  toUpstream: Queue;
  upstream: Socket<undefined> | null;
};

export async function startEgressProxy(
  options: EgressProxyOptions,
): Promise<EgressProxyServer> {
  const logger = options.logger ?? createProxyLogger();
  const resolve = options.resolve ?? systemResolver;
  const dial: UpstreamDialer = options.connect ?? Bun.connect;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const dispatchTimeoutMs =
    options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
  const health =
    options.sourceDigest === undefined
      ? "ok"
      : `ok source=${options.sourceDigest}`;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxPerClient =
    options.maxConnectionsPerClient ?? DEFAULT_MAX_CONNECTIONS_PER_CLIENT;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  let open = 0;
  // One worker must not be able to spend the global budget on its own.
  const perClient = new Map<string, number>();

  const listener: TCPSocketListener<ClientState> = Bun.listen<ClientState>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? DEFAULT_PROXY_PORT,
    socket: {
      close(socket) {
        release(socket);
        socket.data.phase = "closed";
        socket.data.upstream?.end();
      },
      data(socket, chunk) {
        onClientData(socket, chunk);
      },
      drain(socket) {
        // This socket became writable, so what drains is what it is owed.
        flush(socket, socket.data.toClient);
        if (socket.data.toClient.chunks.length > 0) return;
        if (socket.data.closeWhenDrained) {
          socket.data.phase = "closed";
          socket.end();
          return;
        }
        if (socket.data.reuseWhenDrained) {
          nextRequest(socket);
          return;
        }
        const upstream = socket.data.upstream;
        if (upstream !== null) reader(upstream).resume();
        unstall(socket);
      },
      error(socket, error) {
        logger.warn("Client connection failed", { error: error.message });
        release(socket);
        socket.data.upstream?.end();
      },
      open(socket) {
        const remote = socket.remoteAddress;
        socket.data = {
          body: null,
          buffer: new Uint8Array(0),
          discarding: false,
          closeWhenDrained: false,
          reuseWhenDrained: false,
          keepAlive: false,
          reused: false,
          counted: true,
          dispatching: false,
          early: [],
          earlyBytes: 0,
          headTimer: undefined,
          hello: null,
          helloBytes: 0,
          helloCursor: undefined,
          helloTimer: undefined,
          phase: "head",
          releaseDeferred: false,
          remote,
          stallBytes: 0,
          stallTimer: undefined,
          toClient: { bytes: 0, chunks: [] },
          toUpstream: { bytes: 0, chunks: [] },
          tunnelHost: null,
          upstream: null,
        };
        open += 1;
        const mine = (perClient.get(remote) ?? 0) + 1;
        perClient.set(remote, mine);
        if (open > maxConnections) {
          logger.warn("Refusing connection over the concurrency cap", {
            max_connections: maxConnections,
          });
          reply(socket, 503, "proxy is at its connection limit");
          return;
        }
        if (mine > maxPerClient) {
          logger.warn("Refusing connection over this client's cap", {
            client: remote,
            max_per_client: maxPerClient,
          });
          reply(socket, 503, "too many connections from this client");
          return;
        }
        armHeadTimer(socket);
      },
    },
  });

  /**
   * A client that opens a socket and never speaks would otherwise hold its
   * slot forever, which is the whole of the denial of service; a kept
   * connection between requests is held to the same deadline. One that
   * sent nothing since its last answer is closed without a 408: a client
   * that pools it may have just written a request, and would take the 408
   * for that request's answer.
   */
  function armHeadTimer(socket: Socket<ClientState>): void {
    socket.data.headTimer = setTimeout(() => {
      const state = socket.data;
      if (state.phase !== "head") return;
      if (state.reused && state.buffer.byteLength === 0) {
        state.phase = "closed";
        socket.end();
        return;
      }
      logger.warn("Client never finished its request head", {
        client: state.remote,
      });
      reply(socket, 408, "request head timed out");
    }, headTimeoutMs);
  }

  /**
   * The exchange is over and the client asked to keep the connection: what
   * it sends from here is a new request, read and judged as if on a fresh
   * connection. Bytes that arrived before this point were sent before the
   * client had its whole answer — pipelined — and were discarded, so the
   * connection is not kept after all.
   */
  /**
   * The connection may carry another request once this answer ends: the
   * client asked for it, its request body is over and has all been handed
   * to the upstream, nothing arrived past that body, and the dispatch that
   * sent it has returned. An upload the upstream answered before it was
   * over leaves bytes nobody will read as a body. A dispatch still running
   * — an answer the upstream sent before it was asked, delivered from
   * `adopt` — would go on writing the old request into the next one's
   * queue.
   */
  function reusable(socket: Socket<ClientState>): boolean {
    const state = socket.data;
    return (
      state.phase === "piping" &&
      state.keepAlive &&
      !state.discarding &&
      !state.dispatching &&
      state.early.length === 0 &&
      state.toUpstream.chunks.length === 0 &&
      (state.body?.complete ?? false)
    );
  }

  function nextRequest(socket: Socket<ClientState>): void {
    const state = socket.data;
    state.reuseWhenDrained = false;
    if (state.phase === "closed") return;
    if (state.discarding) {
      state.phase = "closed";
      socket.end();
      return;
    }
    clearStallTimer(state);
    state.body = null;
    state.buffer = new Uint8Array(0);
    state.early = [];
    state.earlyBytes = 0;
    state.keepAlive = false;
    state.phase = "head";
    state.reused = true;
    state.toUpstream = { bytes: 0, chunks: [] };
    state.upstream = null;
    // Reading stopped if the old upstream fell behind on the request body.
    reader(socket).resume();
    armHeadTimer(socket);
  }

  function onClientData(socket: Socket<ClientState>, chunk: Uint8Array): void {
    const state = socket.data;
    if (state.phase === "closed") return;
    if (state.phase === "connecting") {
      holdEarly(socket, chunk);
      return;
    }
    if (state.phase === "inspecting") {
      state.earlyBytes += chunk.byteLength;
      state.early.push(chunk);
      absorbHello(socket, chunk);
      inspectTunnel(socket);
      return;
    }
    if (state.phase === "piping") {
      const upstream = state.upstream;
      if (upstream === null) return;
      const bytes = requestBytes(socket, chunk);
      if (bytes === null || bytes.byteLength === 0) return;
      if (!push(upstream, state.toUpstream, bytes, maxBuffered)) {
        stall(
          socket,
          socket,
          "Dropping a connection whose upstream fell behind",
        );
      }
      return;
    }
    state.buffer = concat(state.buffer, chunk);
    const end = headEnd(state.buffer);
    // The cap holds whether or not the terminator arrived in the same chunk
    // as the bytes that crossed it.
    if (
      end < 0
        ? state.buffer.byteLength > MAX_HEAD_BYTES
        : end - 4 > MAX_HEAD_BYTES
    ) {
      reply(socket, 431, "request head is too large");
      return;
    }
    if (end < 0) return;
    clearHeadTimer(state);
    const head = new TextDecoder().decode(state.buffer.subarray(0, end - 4));
    const rest = state.buffer.slice(end);
    state.buffer = new Uint8Array(0);
    void dispatch(socket, parseRequestHead(head), rest);
  }

  async function dispatch(
    socket: Socket<ClientState>,
    request: ProxyRequest,
    rest: Uint8Array,
  ): Promise<void> {
    socket.data.dispatching = true;
    try {
      await runDispatch(socket, request, rest);
    } finally {
      socket.data.dispatching = false;
      if (socket.data.releaseDeferred) release(socket);
    }
  }

  async function runDispatch(
    socket: Socket<ClientState>,
    request: ProxyRequest,
    rest: Uint8Array,
  ): Promise<void> {
    const state = socket.data;
    // Read through a call so the type checker does not narrow `phase` across
    // the awaits below: the client can close while we resolve or connect.
    const closed = (): boolean => socket.data.phase === "closed";
    if (request.kind === "health") {
      reply(socket, 200, health);
      return;
    }
    if (request.kind === "invalid") {
      logger.warn("Rejecting a malformed proxy request", {
        reason: request.reason,
      });
      reply(socket, request.status, request.reason);
      return;
    }
    state.phase = "connecting";
    if (request.kind === "forward") {
      state.body = createBodyFramer(request.body);
      state.keepAlive = request.keepAlive;
    }
    // Bytes pipelined in the same segment as the head are early bytes too.
    if (!holdEarly(socket, rest)) return;
    const expiry = Date.now() + dispatchTimeoutMs;
    const left = (): number => expiry - Date.now();
    let decision: Awaited<ReturnType<typeof decideEgress>>;
    try {
      // `decideEgress` resolves the name, and a resolver has no deadline of
      // its own. Without this race a hung lookup holds the slot for ever.
      decision = await withDeadline(
        decideEgress(
          options.policy,
          { host: request.host, port: request.port },
          resolve,
        ),
        left(),
        `looking up ${request.host} timed out`,
      );
    } catch (error) {
      if (closed()) return;
      const reason = messageOf(error);
      logger.warn("Egress lookup timed out", {
        host: request.host,
        port: request.port,
      });
      reply(socket, 504, reason);
      return;
    }
    if (closed()) return;
    if (!decision.allowed) {
      const unresolved = decision.failure === "unresolved";
      logger.warn(unresolved ? "Egress lookup failed" : "Egress denied", {
        host: request.host,
        method: request.kind,
        port: request.port,
        reason: decision.reason,
      });
      if (unresolved) reply(socket, 502, decision.reason);
      else reply(socket, 403, `egress denied: ${decision.reason}`);
      return;
    }
    // Every address in the decision passed the same policy, so a dead first
    // answer (dual stack, round robin) is a reason to try the next one, not
    // to fail the request.
    const candidates = decision.addresses.slice(0, MAX_CONNECT_ATTEMPTS);
    let upstream: UpstreamAttempt | null = null;
    let lastError = "no address to connect to";
    for (const address of candidates) {
      const budget = Math.min(connectTimeoutMs, left());
      if (budget <= 0) {
        lastError = `dispatch deadline of ${dispatchTimeoutMs}ms exceeded`;
        break;
      }
      let attempt: UpstreamAttempt;
      try {
        attempt = await connectUpstream(
          socket,
          address,
          request.port,
          budget,
          request.kind === "forward"
            ? createResponseRewriter(MAX_HEAD_BYTES, {
                headOnly: request.head.startsWith("HEAD "),
                keepOpen: () => reusable(socket),
              })
            : null,
        );
      } catch (error) {
        lastError = messageOf(error);
        if (closed()) return;
        logger.warn("Upstream connection failed", {
          address,
          error: lastError,
          host: request.host,
          port: request.port,
        });
        continue;
      }
      if (closed()) {
        attempt.abandon();
        return;
      }
      logger.info("Egress allowed", {
        address,
        host: request.host,
        method: request.kind,
        port: request.port,
        scope: decision.scope,
      });
      upstream = attempt;
      break;
    }
    if (upstream === null) {
      reply(socket, 502, `upstream connection failed: ${lastError}`);
      return;
    }
    state.upstream = upstream.socket;
    if (request.kind === "connect") {
      // The client only starts its handshake once it has the 200, and the
      // tunnel only starts carrying bytes once that handshake names the
      // authority we judged. Bytes pipelined behind the CONNECT are already
      // in `early` and go through the same gate.
      state.phase = "inspecting";
      state.tunnelHost = request.host;
      state.hello = new Uint8Array(MAX_CLIENT_HELLO_BYTES);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Adopted after the 200: an upstream that spoke first is delivered
      // behind the status line, never in front of it.
      upstream.adopt();
      state.helloTimer = setTimeout(() => {
        if (socket.data.phase !== "inspecting") return;
        logger.warn(
          "Dropping a tunnel whose client never finished its ClientHello",
          {
            host: request.host,
            port: request.port,
          },
        );
        drop(socket);
      }, handshakeTimeoutMs);
      // Bytes pipelined behind the CONNECT are already in `early`.
      for (const pending of state.early) absorbHello(socket, pending);
      inspectTunnel(socket);
      return;
    }
    state.phase = "piping";
    upstream.adopt();
    push(
      upstream.socket,
      state.toUpstream,
      new TextEncoder().encode(request.head),
      maxBuffered,
    );
    releaseEarly(socket, upstream.socket);
  }

  /** Hands the client's early bytes to the upstream once it may have them. */
  function releaseEarly(
    socket: Socket<ClientState>,
    upstream: Socket<undefined>,
  ): void {
    const state = socket.data;
    state.earlyBytes = 0;
    // Every early chunk was already accepted from the client, so all of them
    // are queued whatever the cap says; only the reading stops.
    let keepingUp = true;
    for (const pending of state.early.splice(0)) {
      keepingUp = push(upstream, state.toUpstream, pending, maxBuffered);
    }
    if (!keepingUp) {
      stall(socket, socket, "Dropping a connection whose upstream fell behind");
    }
  }

  /**
   * Keeps what the client sends while the upstream is still being dialled.
   * That window is bounded in time but not in bytes unless we bound it, and
   * the bound counts only what will be delivered: bytes past a request are
   * discarded here, not held. False once the connection has been dropped.
   */
  function holdEarly(socket: Socket<ClientState>, chunk: Uint8Array): boolean {
    const state = socket.data;
    const bytes = requestBytes(socket, chunk);
    if (bytes === null) return false;
    if (bytes.byteLength === 0) return true;
    state.earlyBytes += bytes.byteLength;
    if (state.earlyBytes > maxBuffered) {
      logger.warn("Dropping a connection that outran the upstream handshake");
      drop(socket);
      return false;
    }
    state.early.push(bytes);
    return true;
  }

  /**
   * What of a client chunk goes to the upstream: all of it on a tunnel, and
   * on a forwarded request only what is still its body. Null once a
   * malformed body has dropped the connection.
   */
  function requestBytes(
    socket: Socket<ClientState>,
    chunk: Uint8Array,
  ): Uint8Array | null {
    const body = socket.data.body;
    if (body === null) return chunk;
    const taken = body.take(chunk);
    if ("error" in taken) {
      logger.warn("Dropping a request whose body is malformed", {
        reason: taken.error,
      });
      drop(socket);
      return null;
    }
    if (taken.dropped > 0 && !socket.data.discarding) {
      // Once per connection: a client can keep sending for as long as the
      // answer takes.
      socket.data.discarding = true;
      logger.warn("Discarding bytes sent past the request", {
        bytes: taken.dropped,
      });
    }
    return taken.forward;
  }

  /**
   * Copies a chunk into the hello buffer, up to the cap. What does not fit
   * is still forwarded from `early` once the gate opens: a small hello
   * followed by early data in the same segment is a hello that fits, and
   * the verdict must not depend on how the socket cut the bytes. A hello
   * still incomplete once the buffer is full is what `inspectTunnel` drops.
   */
  function absorbHello(socket: Socket<ClientState>, chunk: Uint8Array): void {
    const state = socket.data;
    if (state.hello === null) return;
    const room = state.hello.byteLength - state.helloBytes;
    const take = chunk.subarray(0, Math.min(room, chunk.byteLength));
    state.hello.set(take, state.helloBytes);
    state.helloBytes += take.byteLength;
  }

  /**
   * The gate on a CONNECT tunnel: the client's first bytes have to be a
   * ClientHello for the authority it asked for. Every other outcome is a
   * drop, including a hello that never finishes — a check that lets the
   * unparseable through is a check that can be routed around.
   */
  function inspectTunnel(socket: Socket<ClientState>): void {
    const state = socket.data;
    const upstream = state.upstream;
    const host = state.tunnelHost;
    if (upstream === null || host === null || state.hello === null) return;
    const verdict = parseClientHelloSni(
      state.hello.subarray(0, state.helloBytes),
      state.helloCursor,
    );
    const refuse = (reason: string): void => {
      logger.warn("Dropping a tunnel whose ClientHello failed the gate", {
        host,
        reason,
      });
      drop(socket);
    };
    if (verdict.kind === "incomplete") {
      state.helloCursor = verdict.cursor;
      if (state.helloBytes >= state.hello.byteLength) {
        refuse(`no ClientHello within ${MAX_CLIENT_HELLO_BYTES} bytes`);
      }
      return;
    }
    if (verdict.kind === "reject") {
      refuse(verdict.reason);
      return;
    }
    // A TLS client does not send a server name for an IP literal (RFC 6066
    // §3), and an allowlist entry that is an address already pins the
    // address itself; there is nothing further for the name to bind. One
    // that does send a name is asking for something we did not judge.
    if (isIP(host) !== 0) {
      if (verdict.kind === "sni") {
        refuse(`server name ${verdict.host} sent to the address ${host}`);
        return;
      }
    } else if (verdict.kind === "no-sni") {
      refuse("ClientHello carries no server name");
      return;
    } else if (verdict.host.toLowerCase() !== host) {
      refuse(
        `server name ${verdict.host} is not the CONNECT authority ${host}`,
      );
      return;
    }
    clearHelloTimer(state);
    state.hello = null;
    state.phase = "piping";
    releaseEarly(socket, upstream);
  }

  /**
   * `answer` reads a forwarded exchange's answer on its way to the client
   * (response.ts); a tunnel's bytes are TLS and pass untouched.
   */
  function connectUpstream(
    client: Socket<ClientState>,
    address: string,
    port: number,
    timeoutMs: number,
    answer: ResponseRewriter | null,
  ): Promise<UpstreamAttempt> {
    // The client socket lives in this closure rather than in `socket.data`:
    // a connection that fails before `open` never gets its data assigned,
    // and the handlers still have to be able to clean up.
    //
    // An attempt we gave up on can still open afterwards, and one that
    // opened can speak before the dial reports back. By then another address
    // may be carrying the tunnel, so nothing here reaches the client until
    // `adopt`: bytes are held, a close or error is remembered, and a hold
    // past the cap pauses this socket alone. The connect deadline bounds how
    // long any of it can sit.
    let phase: "pending" | "adopted" | "abandoned" | "finished" = "pending";
    const held: Queue = { bytes: 0, chunks: [] };
    let closedEarly = false;
    let failedEarly: Error | null = null;
    let upstream: Socket<undefined> | null = null;
    /** A forwarded answer the client must not see a torn piece of. */
    const refuseAnswer = (reason: string): void => {
      // The upstream's close after our own 502 comes back through here.
      if (client.data.phase === "closed") return;
      logger.warn("Dropping a forwarded response that failed its framing", {
        reason,
      });
      upstream?.end();
      if (answer?.started) drop(client);
      else reply(client, 502, `upstream ${reason}`);
    };
    /** false once the client's queue is past its cap. */
    const deliver = (chunk: Uint8Array): boolean => {
      if (phase === "finished" || client.data.phase === "closed") return true;
      if (answer === null) {
        return push(client, client.data.toClient, chunk, maxBuffered);
      }
      const result = answer.push(chunk);
      if ("error" in result) {
        refuseAnswer(result.error);
        return true;
      }
      const keepingUp =
        result.bytes.byteLength === 0 ||
        push(client, client.data.toClient, result.bytes, maxBuffered);
      if (!answer.complete) return keepingUp;
      // The exchange is over whether or not the upstream agrees. From here
      // nothing this upstream does reaches the client, which may already be
      // on its next request.
      phase = "finished";
      upstream?.end();
      if (answer.closes || !reusable(client)) {
        // Ending it here is what stops a client that ignores
        // `connection: close` from waiting on this socket for an answer to
        // its next request.
        endClient();
      } else if (client.data.toClient.chunks.length > 0) {
        client.data.reuseWhenDrained = true;
      } else {
        nextRequest(client);
      }
      return true;
    };
    /** Ends the client once whatever it is still owed has been written. */
    const endClient = (): void => {
      if (client.data.toClient.chunks.length > 0) {
        client.data.closeWhenDrained = true;
        return;
      }
      client.end();
    };
    const onClose = (): void => {
      if (phase === "finished") return;
      if (answer !== null && !answer.done) {
        refuseAnswer("closed before its response head was complete");
        return;
      }
      // The upstream closing is how a close-delimited response ends — but
      // the tail of that response may still be queued for a slow client.
      endClient();
    };
    const onError = (error: Error): void => {
      if (phase === "finished") return;
      logger.warn("Upstream connection failed", { error: error.message });
      client.end();
    };
    const pending = dial({
      hostname: address,
      port,
      socket: {
        close() {
          if (phase === "abandoned") return;
          if (phase === "pending") {
            closedEarly = true;
            return;
          }
          onClose();
        },
        data(socket, chunk) {
          if (phase === "abandoned") return;
          if (phase === "pending") {
            held.chunks.push(chunk);
            held.bytes += chunk.byteLength;
            if (held.bytes > maxBuffered) reader(socket).pause();
            return;
          }
          if (!deliver(chunk)) {
            stall(
              client,
              socket,
              "Dropping a connection whose client fell behind",
            );
          }
        },
        drain(socket) {
          if (phase !== "adopted") return;
          // The upstream became writable, so what drains is what it is owed.
          flush(socket, client.data.toUpstream);
          if (client.data.toUpstream.chunks.length > 0) return;
          reader(client).resume();
          unstall(client);
        },
        error(_socket, error) {
          if (phase === "abandoned") return;
          if (phase === "pending") {
            failedEarly = error;
            return;
          }
          onError(error);
        },
      },
    });
    const attempt = (socket: Socket<undefined>): UpstreamAttempt => {
      upstream = socket;
      return {
        socket,
        adopt() {
          if (phase !== "pending") return;
          phase = "adopted";
          let keepingUp = true;
          for (const chunk of held.chunks.splice(0)) {
            keepingUp = deliver(chunk);
          }
          held.bytes = 0;
          if (keepingUp) reader(socket).resume();
          else
            stall(
              client,
              socket,
              "Dropping a connection whose client fell behind",
            );
          if (failedEarly !== null) onError(failedEarly);
          else if (closedEarly) onClose();
        },
        abandon() {
          if (phase !== "pending") return;
          phase = "abandoned";
          held.chunks.length = 0;
          held.bytes = 0;
          socket.end();
        },
      };
    };
    // Bun.connect has no deadline of its own; a black-holed address would
    // otherwise hold the client socket open forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // The connect may still succeed after we gave up on it; close it
        // rather than leak a socket nobody is reading.
        phase = "abandoned";
        held.chunks.length = 0;
        held.bytes = 0;
        pending.then((late) => late.end()).catch(() => undefined);
        reject(
          new Error(
            `connect to ${address}:${port} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref();
    });
    // Without the clear, every short-lived request leaves a live timer and
    // its closure registered for the full deadline.
    return Promise.race([pending.then(attempt), deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /** Bounds a promise that has no deadline of its own; the loser is dropped. */
  function withDeadline<T>(
    pending: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
      timer.unref();
    });
    return Promise.race([pending, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * A queue past its cap means one side is slower than the other. Stop
   * reading from the fast side rather than dropping the pair: the bytes
   * already accepted still have to arrive in order, and a transfer cut at
   * the cap reaches the worker as a truncated download, not as an error it
   * can act on. The deadline is what still separates a slow peer from one
   * that has stopped reading — past the request head nothing else reaps it.
   */
  function stall(
    socket: Socket<ClientState>,
    source: Socket<unknown>,
    reason: string,
  ): void {
    reader(source).pause();
    if (socket.data.stallTimer !== undefined) return;
    arm(socket, reason);
  }

  /**
   * The deadline measures a window with no progress, not the age of the
   * stall. A peer reading at a steady trickle can take longer than the
   * timeout to clear a full queue, and cutting it there would be the
   * truncation this exists to remove.
   */
  function arm(socket: Socket<ClientState>, reason: string): void {
    socket.data.stallBytes = owed(socket.data);
    socket.data.stallTimer = setTimeout(() => {
      if (owed(socket.data) < socket.data.stallBytes) {
        arm(socket, reason);
        return;
      }
      socket.data.stallTimer = undefined;
      logger.warn(reason);
      drop(socket);
    }, stallTimeoutMs);
  }

  function owed(state: ClientState): number {
    return state.toClient.bytes + state.toUpstream.bytes;
  }

  /** Both queues drained, so neither side is owed anything: disarm. */
  function unstall(socket: Socket<ClientState>): void {
    if (socket.data.stallTimer === undefined) return;
    if (socket.data.toClient.chunks.length > 0) return;
    if (socket.data.toUpstream.chunks.length > 0) return;
    clearTimeout(socket.data.stallTimer);
    socket.data.stallTimer = undefined;
  }

  function clearStallTimer(state: ClientState): void {
    if (state.stallTimer === undefined) return;
    clearTimeout(state.stallTimer);
    state.stallTimer = undefined;
  }

  function clearHelloTimer(state: ClientState): void {
    if (state.helloTimer === undefined) return;
    clearTimeout(state.helloTimer);
    state.helloTimer = undefined;
  }

  function clearHeadTimer(state: ClientState): void {
    if (state.headTimer === undefined) return;
    clearTimeout(state.headTimer);
    state.headTimer = undefined;
  }

  function release(socket: Socket<ClientState>): void {
    clearHeadTimer(socket.data);
    clearHelloTimer(socket.data);
    clearStallTimer(socket.data);
    if (!socket.data.counted) return;
    if (socket.data.dispatching) {
      // The outbound attempt outlives the client socket by up to the connect
      // deadline. Freeing the slot now would let a client that disconnects
      // immediately open another one per in-flight connect and walk past
      // both caps while the dead sockets pile up.
      socket.data.releaseDeferred = true;
      return;
    }
    socket.data.counted = false;
    open -= 1;
    const mine = (perClient.get(socket.data.remote) ?? 1) - 1;
    if (mine <= 0) perClient.delete(socket.data.remote);
    else perClient.set(socket.data.remote, mine);
  }

  function drop(socket: Socket<ClientState>): void {
    socket.data.upstream?.end();
    socket.data.phase = "closed";
    socket.end();
  }

  function reply(
    socket: Socket<ClientState>,
    status: number,
    message: string,
  ): void {
    const body = `${message}\n`;
    socket.data.phase = "closed";
    clearHeadTimer(socket.data);
    socket.end(
      `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\n` +
        "content-type: text/plain; charset=utf-8\r\n" +
        `content-length: ${new TextEncoder().encode(body).byteLength}\r\n` +
        "connection: close\r\n\r\n" +
        body,
    );
  }

  logger.info("Egress proxy listening", {
    allow: options.policy.allow.map(describe),
    allow_private: options.policy.allowPrivate.map(describe),
    port: listener.port,
    source: options.sourceDigest,
  });
  return {
    port: listener.port,
    stop(): void {
      listener.stop(true);
    },
  };
}

function describe(destination: { host: string; port: number }): string {
  return `${destination.host}:${destination.port}`;
}

// libc, not node:dns: Bun's node:dns answers from c-ares, which keeps a
// record for its TTL, and Docker's embedded DNS gives 600s, so an api, fake-git
// or LocalStack that restarts on a new address would be dialed at its old one
// for up to ten minutes. libc keeps no cache and asks every time (
// packages/system/src/fresh-lookup.ts, which this image cannot import).
export const systemResolver: EgressResolver = async (host) => {
  const entries = await Bun.dns.lookup(host, { backend: "libc" });
  return entries.map((entry) => entry.address);
};

function reasonPhrase(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 408:
      return "Request Timeout";
    case 431:
      return "Request Header Fields Too Large";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 505:
      return "HTTP Version Not Supported";
    default:
      return "Error";
  }
}

/** false once the queue is past the cap, which the caller answers by pausing. */
function push(
  target: Socket<unknown>,
  queue: Queue,
  chunk: Uint8Array,
  max: number,
): boolean {
  let remainder = chunk;
  if (queue.chunks.length === 0) {
    // A closed socket reports -1, which must not be read as an offset.
    const written = Math.max(0, target.write(chunk));
    if (written >= chunk.byteLength) return true;
    remainder = chunk.subarray(written);
  }
  queue.chunks.push(remainder);
  queue.bytes += remainder.byteLength;
  return queue.bytes <= max;
}

function flush(target: Socket<unknown>, queue: Queue): void {
  while (queue.chunks.length > 0) {
    const head = queue.chunks[0];
    if (head === undefined) return;
    const written = Math.max(0, target.write(head));
    if (written === 0) return;
    queue.bytes -= written;
    if (written < head.byteLength) {
      queue.chunks[0] = head.subarray(written);
      return;
    }
    queue.chunks.shift();
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

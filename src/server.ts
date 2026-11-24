import http from "node:http";
import { Keypair } from "@solana/web3.js";
import {
  InMemoryUptoOperator,
  paymentGate,
  MockChain,
  type Meter,
  type OfferExtraInput,
  type UptoOperator,
  type UptoPaymentEnvelope,
} from "allowance-kit";
import { RPC, liveReport, scanConfig, type LiveReport } from "./reader.ts";

export interface ReportServerOptions {
  network?: string;
  rpcUrl?: string;
  perReportMicro?: bigint;
  ceilingMicro?: bigint;
  payTo?: string;
  operator?: UptoOperator;
  reportFn?: (o: { rpcUrl: string; pool: string; holder?: string; referenceBuyQuote?: number }) => Promise<LiveReport>;
  scanFn?: (rpcUrl: string, config: string, ref?: number) => Promise<LiveReport[]>;
  port?: number;
  host?: string;
}

export interface ReportServer {
  url: string;
  port: number;
  perReportMicro: bigint;
  ceilingMicro: bigint;
  operator: UptoOperator;
  served: number;
  close(): Promise<void>;
}

export function pinnedOperator(): { operator: UptoOperator; base: InMemoryUptoOperator } {
  const base = new InMemoryUptoOperator({ feePayer: randomAddr(), receiverAuthorizer: randomAddr() });
  const blockhash = randomAddr();
  const operator: UptoOperator = {
    offerExtra: async (i: OfferExtraInput) => ({
      ...(await base.offerExtra(i)),
      recentBlockhash: blockhash,
      recentSlot: 200_000_000,
      lastValidBlockHeight: 200_000_150,
    }),
    openDeposit: (e: UptoPaymentEnvelope) => base.openDeposit(e),
    settleClaim: (e: UptoPaymentEnvelope, a: bigint) => base.settleClaim(e, a),
  };
  return { operator, base };
}

export function randomAddr(): string {
  return Keypair.generate().publicKey.toBase58();
}

export async function startReportServer(o: ReportServerOptions = {}): Promise<ReportServer> {
  const network = o.network ?? "solana-devnet";
  const rpcUrl = o.rpcUrl ?? RPC[(network === "solana" ? "solana" : "solana-devnet") as keyof typeof RPC];
  const perReportMicro = o.perReportMicro ?? 10_000n;
  const ceilingMicro = o.ceilingMicro ?? 100_000n;
  const operator = o.operator ?? pinnedOperator().operator;
  const reportFn = o.reportFn ?? liveReport;
  const scanFn = o.scanFn ?? scanConfig;
  const state = { served: 0 };

  const gate = paymentGate(
    {
      priceMicro: perReportMicro,
      description: "DBC downside report: exit value, fee, shortfall, buys-to-graduate, lockup",
      payTo: o.payTo ?? randomAddr(),
      network,
      facilitator: new MockChain(),
      upto: { ceilingMicro, operator },
    },
    async (req, res, meter?: Meter) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, body: unknown) => {
        res.statusCode = code;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };
      try {
        if (url.pathname === "/report") {
          const pool = url.searchParams.get("pool");
          if (!pool) return json(400, { error: "pool required" });
          const r = await reportFn({
            rpcUrl,
            pool,
            holder: url.searchParams.get("holder") ?? undefined,
            referenceBuyQuote: Number(url.searchParams.get("ref") ?? 100),
          });
          meter?.charge(perReportMicro);
          state.served += 1;
          return json(200, r);
        }
        if (url.pathname === "/scan") {
          const config = url.searchParams.get("config");
          if (!config) return json(400, { error: "config required" });
          const rs = await scanFn(rpcUrl, config, Number(url.searchParams.get("ref") ?? 100));
          meter?.charge(perReportMicro * BigInt(rs.length));
          state.served += rs.length;
          return json(200, rs);
        }
        return json(404, { error: "not found" });
      } catch (e) {
        return json(502, { error: (e as Error).message });
      }
    },
  );

  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, network, perReportMicro: perReportMicro.toString(), ceilingMicro: ceilingMicro.toString() }));
      return;
    }
    await gate(req, res);
  });
  await gate.ready();
  const host = o.host ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(o.port ?? 0, host, () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    port,
    perReportMicro,
    ceilingMicro,
    operator,
    get served() {
      return state.served;
    },
    close: async () => {
      await gate.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

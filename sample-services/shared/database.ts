import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import { Pool, PoolConfig } from "pg";
import fs from "fs";
import path from "path";

export type StorageType = "REMOTE_POSTGRESQL" | "LOCAL_DEV_STORAGE";

export interface DatabaseFaultConfig {
  latencyMs: number;
  failureRate: number; // 0.0 to 1.0
  errorMessage?: string;
}

export interface DatabaseDiagnostics {
  storageType: StorageType;
  isRealPostgresConnected: boolean;
  connectionUrl: string;
  lastConnectionError: string | null;
  totalQueriesExecuted: number;
  activePoolClients: number;
  faultConfig: DatabaseFaultConfig;
  localStoreItemCount?: number;
}

interface LocalStoreSchema {
  inventory_items: Array<{ sku: string; name: string; stock: number; updated_at: string }>;
  orders: Array<{ id: string; sku: string; amount: number; status: string; created_at: string }>;
  payment_transactions: Array<{ tx_id: string; amount: number; status: string; created_at: string }>;
}

export class SamplePostgresClient {
  private static instance: SamplePostgresClient;
  private pool: Pool | null = null;
  private storageType: StorageType = "LOCAL_DEV_STORAGE";
  private isRealPostgresConnected: boolean = false;
  private lastConnectionError: string | null = null;
  private totalQueriesExecuted: number = 0;
  private connectionUrl: string;
  private schemaInitialized: boolean = false;
  private localStorePath: string;
  private localStore: LocalStoreSchema;

  private faultConfig: DatabaseFaultConfig = {
    latencyMs: 12, // Baseline ~12ms
    failureRate: 0.0,
  };

  private constructor() {
    this.connectionUrl =
      process.env.SAMPLE_DATABASE_URL ||
      process.env.POSTGRES_URL ||
      "";

    this.localStorePath = path.join(process.cwd(), "sample-services", "data", "sample_store.json");
    this.localStore = this.initLocalStore();

    if (this.connectionUrl) {
      this.initPool();
    } else {
      this.lastConnectionError = "No external PostgreSQL URL configured. Using zero-admin local storage.";
    }
  }

  public static getInstance(): SamplePostgresClient {
    if (!SamplePostgresClient.instance) {
      SamplePostgresClient.instance = new SamplePostgresClient();
    }
    return SamplePostgresClient.instance;
  }

  private initLocalStore(): LocalStoreSchema {
    try {
      const dir = path.dirname(this.localStorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.localStorePath)) {
        const raw = fs.readFileSync(this.localStorePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // Fallback if filesystem read error
    }

    const defaultStore: LocalStoreSchema = {
      inventory_items: [
        { sku: "ITEM-101", name: "High-Performance Cloud Router", stock: 500, updated_at: new Date().toISOString() },
        { sku: "ITEM-102", name: "Fiber Optic Transceiver", stock: 250, updated_at: new Date().toISOString() },
        { sku: "ITEM-103", name: "Managed Switch 48-Port", stock: 80, updated_at: new Date().toISOString() },
      ],
      orders: [],
      payment_transactions: [],
    };

    try {
      fs.writeFileSync(this.localStorePath, JSON.stringify(defaultStore, null, 2));
    } catch {
      // Ignore write failure if read-only
    }

    return defaultStore;
  }

  private persistLocalStore(): void {
    try {
      fs.writeFileSync(this.localStorePath, JSON.stringify(this.localStore, null, 2));
    } catch {
      // Memory fallback remains consistent for the process lifetime
    }
  }

  private initPool(): void {
    try {
      const poolConfig: PoolConfig = {
        connectionString: this.connectionUrl,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 5000,
        max: 10,
        ssl: this.connectionUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
      };

      this.pool = new Pool(poolConfig);

      this.pool.on("error", (err) => {
        this.lastConnectionError = err.message;
        this.isRealPostgresConnected = false;
        this.storageType = "LOCAL_DEV_STORAGE";
      });
    } catch (err: unknown) {
      this.lastConnectionError = err instanceof Error ? err.message : String(err);
      this.isRealPostgresConnected = false;
      this.storageType = "LOCAL_DEV_STORAGE";
    }
  }

  /**
   * Performs a database readiness check.
   */
  public async checkReadiness(): Promise<{ ready: boolean; storageType: StorageType; error?: string; localStoreItemCount?: number }> {
    const totalLocalItems =
      this.localStore.inventory_items.length +
      this.localStore.orders.length +
      this.localStore.payment_transactions.length;

    if (this.pool && this.connectionUrl) {
      try {
        const client = await this.pool.connect();
        try {
          await client.query("SELECT 1 AS readiness_check");
          this.isRealPostgresConnected = true;
          this.storageType = "REMOTE_POSTGRESQL";
          this.lastConnectionError = null;

          if (!this.schemaInitialized) {
            await this.initializePostgresSchema(client);
          }

          return { ready: true, storageType: "REMOTE_POSTGRESQL" };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.isRealPostgresConnected = false;
        this.storageType = "LOCAL_DEV_STORAGE";
        this.lastConnectionError = msg;
        // Fall back to zero-admin local storage
        return {
          ready: true,
          storageType: "LOCAL_DEV_STORAGE",
          error: `PostgreSQL error: ${msg}. Operating in local storage mode.`,
          localStoreItemCount: totalLocalItems,
        };
      }
    }

    // Zero-admin local storage is always ready without needing elevation
    this.storageType = "LOCAL_DEV_STORAGE";
    return { ready: true, storageType: "LOCAL_DEV_STORAGE", localStoreItemCount: totalLocalItems };
  }

  private async initializePostgresSchema(client: { query: (q: string) => Promise<unknown> }): Promise<void> {
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_items (
          sku VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          stock INT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS orders (
          id VARCHAR(64) PRIMARY KEY,
          sku VARCHAR(64) NOT NULL,
          amount NUMERIC(10, 2) NOT NULL,
          status VARCHAR(32) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS payment_transactions (
          tx_id VARCHAR(64) PRIMARY KEY,
          amount NUMERIC(10, 2) NOT NULL,
          status VARCHAR(32) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO inventory_items (sku, name, stock)
        VALUES
          ('ITEM-101', 'High-Performance Cloud Router', 500),
          ('ITEM-102', 'Fiber Optic Transceiver', 250),
          ('ITEM-103', 'Managed Switch 48-Port', 80)
        ON CONFLICT (sku) DO NOTHING;
      `);
      this.schemaInitialized = true;
      console.log("[SampleDatabase] Remote PostgreSQL schema verified & ready.");
    } catch (err) {
      console.warn("[SampleDatabase] Schema initialization warning:", err);
    }
  }

  public setFault(fault: Partial<DatabaseFaultConfig>) {
    this.faultConfig = { ...this.faultConfig, ...fault };
    console.log(`[SampleDatabase] Injected fault configuration updated:`, this.faultConfig);
  }

  public resetFault() {
    this.faultConfig = {
      latencyMs: 12,
      failureRate: 0.0,
    };
    console.log(`[SampleDatabase] Fault configuration restored to baseline (12ms latency, 0% failure).`);
  }

  public getFaultConfig(): DatabaseFaultConfig {
    return { ...this.faultConfig };
  }

  public getDiagnostics(): DatabaseDiagnostics {
    return {
      storageType: this.storageType,
      isRealPostgresConnected: this.isRealPostgresConnected,
      connectionUrl: this.connectionUrl ? this.connectionUrl.replace(/:[^:@]+@/, ":***@") : "none (Local storage active)",
      lastConnectionError: this.lastConnectionError,
      totalQueriesExecuted: this.totalQueriesExecuted,
      activePoolClients: this.pool?.totalCount || 0,
      faultConfig: { ...this.faultConfig },
      localStoreItemCount: this.localStore.inventory_items.length + this.localStore.orders.length,
    };
  }

  /**
   * Executes a database query operation with OpenTelemetry database span attributes.
   * Transparently executes against remote PostgreSQL if connected, or the zero-admin
   * local development repository.
   */
  public async query<T = unknown>(
    operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
    table: string,
    statement: string,
    data?: T,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number; durationMs: number; storageType: StorageType }> {
    const tracer = trace.getTracer("postgres-db", "1.0.0");
    const span = tracer.startSpan(`db.${operation.toLowerCase()}.${table}`, {
      attributes: {
        "db.system": this.isRealPostgresConnected ? "postgresql" : "local_embedded_store",
        "db.name": "sample_ecommerce",
        "db.operation": operation,
        "db.sql.table": table,
        "db.statement": statement,
        "db.storage_type": this.storageType,
        "db.is_real_postgres": this.isRealPostgresConnected,
      },
    }, context.active());

    const start = performance.now();
    this.totalQueriesExecuted++;

    try {
      // Simulate/apply injected database fault delay if configured
      if (this.faultConfig.latencyMs > 0) {
        const addedLatency = this.faultConfig.latencyMs + (Math.random() * 4 - 2);
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, addedLatency)));
      }

      // Check if failure injection triggered
      if (this.faultConfig.failureRate > 0 && Math.random() < this.faultConfig.failureRate) {
        const errMessage = this.faultConfig.errorMessage || "database query timeout / lock contention";
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage });
        span.recordException(new Error(errMessage));
        throw new Error(`[Database Fault Error]: ${errMessage}`);
      }

      // Branch 1: Real remote PostgreSQL execution
      if (this.isRealPostgresConnected && this.pool) {
        const res = await this.pool.query(statement, params);
        span.setStatus({ code: SpanStatusCode.OK });
        const durationMs = Math.round(performance.now() - start);

        return {
          rows: res.rows as T[],
          rowCount: res.rowCount || 0,
          durationMs,
          storageType: "REMOTE_POSTGRESQL",
        };
      }

      // Branch 2: Zero-admin local storage execution
      span.setAttribute("db.client.mode", "local_dev_store");

      // Perform local store update based on table
      if (operation === "INSERT" && data) {
        if (table === "orders") {
          this.localStore.orders.push(data as unknown as LocalStoreSchema["orders"][0]);
        } else if (table === "payment_transactions") {
          this.localStore.payment_transactions.push(data as unknown as LocalStoreSchema["payment_transactions"][0]);
        }
        this.persistLocalStore();
      }

      span.setStatus({ code: SpanStatusCode.OK });
      const durationMs = Math.round(performance.now() - start);

      return {
        rows: data ? [data] : [],
        rowCount: 1,
        durationMs,
        storageType: "LOCAL_DEV_STORAGE",
      };
    } catch (err: unknown) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isRealPostgresConnected = false;
      this.storageType = "LOCAL_DEV_STORAGE";
    }
  }
}

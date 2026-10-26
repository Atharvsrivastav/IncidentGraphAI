import "dotenv/config";
import { defineConfig } from "prisma/config";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./dev.db";
}

const dbUrl = process.env.DATABASE_URL;
const isPostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");

export default defineConfig({
  schema: isPostgres ? "prisma/schema.postgresql.prisma" : "prisma/schema.prisma",
  migrations: {
    path: isPostgres ? "prisma/migrations-postgres" : "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    url: dbUrl,
  },
});

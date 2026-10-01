// PM2 process definition for production.
//
// The server is pre-bundled by `npm run build` (next build + scripts/build-server.mjs) and run with
// plain `node`. Do NOT point this at `npx tsx src/server/index.ts` again: tsx's loader thread kept a
// whole CPU core busy on the VPS even when the gateway was idle.
//
// First deploy after switching from the tsx-based config (PM2 keeps the old script path on reload):
//   pm2 delete waba && pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: "waba",
      script: "dist/server/index.js",
      cwd: __dirname,
      node_args: "--enable-source-maps",
      watch: false,
      autorestart: true,
      max_memory_restart: "2G",
      exec_mode: "fork",
      instances: 1,
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production"
      },
      env_production: {
        NODE_ENV: "production"
      },
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};

/** PM2 Process Manager Configuration for AgentClaw
 *  Run: pm2 start ecosystem.config.cjs
 *  Monitor: pm2 monit
 *  Logs: pm2 logs agentclaw
 *  
 *  Built by Aditya Waghamare
 */
module.exports = {
  apps: [
    {
      name: "agentclaw",
      script: "./dist/index.js",
      node_args: "--expose-gc --max-old-space-size=2048",
      instances: 1,
      autorestart: true,
      watch: false,
      // Auto-restart if memory exceeds 1.8GB (leaves buffer before 2GB limit)
      max_memory_restart: "1800M",
      // Restart strategy: exponential backoff to avoid restart storms
      exp_backoff_restart_delay: 1000,
      // Environment
      env: {
        NODE_ENV: "production",
      },
      // Log configuration
      error_file: "./logs/agentclaw-error.log",
      out_file: "./logs/agentclaw-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Merge stdout and stderr into one log
      merge_logs: true,
      // Max log file size before rotation (10MB)
      max_size: "10M",
      // Keep 5 rotated log files
      retain: 5,
    },
  ],
};

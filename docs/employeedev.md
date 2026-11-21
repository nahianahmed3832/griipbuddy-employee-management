# Employee development on Hostinger

`employeedev.griipbuddy.com` serves the employee app in its own Compose project, `griipbuddy-employee-dev`. The app listens on Hostinger loopback port 3101. It uses fresh development PostgreSQL and document volumes. Populate the development instance with synthetic accounts and data. The deployment uses its own in-app notification worker. External email settings and production configuration belong outside this deployment.

## Prepare the release

1. Verify that the approved development host has capacity for the employee app image and its PostgreSQL base, including temporary build or load space. Verify loopback port 3101 is free and its route is absent before the initial deployment.
2. Extract the pinned Git source under `/srv/griipbuddy-employee-dev/releases/<revision>`. Keep the source tree layout intact so the database initializer resolves from the Compose file. Build the existing Dockerfile for `linux/amd64` with the full source revision as the `org.opencontainers.image.revision` image label. Inspect the image ID and architecture before promoting it.
3. Make `/srv/griipbuddy-employee-dev/employee.env` from `deploy/employeedev.env.example` with mode 0600. Fill in the inspected development image ID and three independent random hex secrets. Keep the one-time synthetic admin password outside this reusable runtime file. The normal application container receives only the non-owner database account.

From the release directory, use the dedicated project and absolute environment path.

```sh
employee_dev() {
  docker compose --project-name griipbuddy-employee-dev \
    --env-file /srv/griipbuddy-employee-dev/employee.env \
    --file deploy/employeedev.compose.yaml "$@"
}
employee_dev config --quiet
employee_dev up -d --no-build --wait employee-db
employee_dev run --rm -T --no-deps employee-tools node_modules/prisma/build/index.js migrate deploy
employee_dev run --rm -T --no-deps employee-tools --import tsx scripts/runtime-grants.ts
```

Initialize the empty database once, using a synthetic admin address in a reserved `example.test` domain and a random temporary password of at least 12 characters. Pass the one-time values to the tools container by environment name, then clear them from the shell. The bootstrap command refuses to create an administrator if any user exists.

```sh
employee_dev run --rm -T --no-deps \
  -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_NAME -e BOOTSTRAP_ADMIN_PASSWORD \
  employee-tools --import tsx scripts/bootstrap.ts
unset BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_PASSWORD
employee_dev up -d --no-build --wait employee-app
curl -fsS http://127.0.0.1:3101/api/health/ready
```

## Route and verify

Use a dedicated HTTPS virtual host for `employeedev.griipbuddy.com` with upstream `http://127.0.0.1:3101`. Preserve `Host` and the HTTPS scheme through `X-Forwarded-Proto`, limit uploads to 16 MB, and send `X-Robots-Tag: noindex, nofollow`. Validate the Nginx configuration before its graceful reload.

Verify HTTPS readiness and `/login`, then confirm `/dashboard` redirects a guest and that private APIs reject anonymous requests. Use the one-time synthetic admin credentials on the development hostname, complete its required password change, and confirm the dashboard loads. Keep the database and document volumes if the development route is withdrawn. To withdraw a failed first rollout, remove only the new virtual host and stop the `employee-app` service in this project.

## Development in-app notification worker

R10 adds a development-specific worker. The original `griipbuddy-employee-notifications.timer` belongs to the separate legacy Compose project and cannot resolve the development database. The new unit executes a one-off command inside the healthy canonical development app, using its runtime database account.

Once the immutable candidate passes the disposable database rehearsal, pre-migration backup and private readiness checks, install the versioned `deploy/griipbuddy-employee-dev-notifications.service` and corresponding `.timer` in `/etc/systemd/system`. Run `systemd-analyze verify` on both units and reload systemd. Enable the development timer only after the application and migration are verified. The timer polls every five minutes for the existing 18:10 UTC daily schedule and for retries. A missed invocation considers the most recent scheduled slot. Its due-date evaluation uses the organization timezone saved on the first attempt. Stop the development timer and service during a release or application rollback.

Operators with development host access can check the last 20 attempts or retry a failed/interrupted slot:

```sh
docker exec griipbuddy-employee-dev-employee-app-1 node --conditions=react-server --import tsx scripts/notifications-due.ts status
docker exec griipbuddy-employee-dev-employee-app-1 node --conditions=react-server --import tsx scripts/notifications-due.ts retry YYYY-MM-DD
```

The retry date is the scheduled UTC date. The timer retries after 5, 15, 45 and 120 minutes. A successful slot cannot be replayed. A database connection failure appears in the service journal and is retried on the next poll. As soon as the database is reachable the attempt ledger records processing state, committed counts and failure codes. `publishedCount` counts new recipient rows committed to the in-app inbox by that attempt. It does not measure whether a recipient opened the inbox. The worker calls no external email, SMS or push providers.

When reverting the application to the R09 image, disable the development timer and restore the previous Compose image pin. Keep the additive attempt table and in-app rows. Resume the timer only with a release that supports its command. Leave the distinct legacy Compose project and its unit intact.

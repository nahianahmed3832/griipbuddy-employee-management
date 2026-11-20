# Employee development on Hostinger

`employeedev.griipbuddy.com` serves the employee app in its own Compose project, `griipbuddy-employee-dev`. The app listens on Hostinger loopback port 3101. It uses fresh development PostgreSQL and document volumes. Populate the development instance with synthetic accounts and data. External email settings, the daily notification timer, and production configuration belong outside this deployment.

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

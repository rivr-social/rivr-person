# OpenClaw Web — Sidecar Build Context

This directory is the Docker build context for the `openclaw-web` service
in the sidecar stack. Before building, copy the required source files
from the Autobot repository:

```bash
# From the rivr-person root:
cp ../Autobot/token-server/server.js sidecar/openclaw-web/server.js
cp ../Autobot/token-server/package.json sidecar/openclaw-web/package.json
cp -r ../Autobot/web/ sidecar/openclaw-web/web/
```

Then build:

```bash
docker build -t openclaw-web:local sidecar/openclaw-web/
```

The `docker-compose.sidecar.yml` file handles this automatically via
the `build.context` directive when the files are in place.

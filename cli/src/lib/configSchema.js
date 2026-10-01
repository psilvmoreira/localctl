const { z } = require('zod');
const { knownAddonTypes } = require('./manifestGen');

// Dependency types are discovered from cli/src/lib/addons/<type>/addon.yaml (see
// docs/adding-tools.md) rather than hardcoded here - dropping in a new addon folder is enough to
// make it usable, no code change needed.
const dependencySchema = z.object({
  type: z.enum(knownAddonTypes()),
  version: z.string().optional(),
  database: z.string().optional(),
  storage: z.string().optional(),
});

const debugSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().optional(),
    type: z.enum(['node', 'python', 'go', 'java', 'dotnet']).optional(),
  })
  .default({ enabled: false });

const syncEntrySchema = z.object({
  localPath: z.string(),
  remotePath: z.string(),
});

// An extra container in the same pod as your app - the classic k8s sidecar pattern (a DB admin
// UI next to a database, a log/metrics shipper, a background job runner next to a web app). It
// shares the pod's network namespace with your app automatically - no Service needed for your app
// to reach it, just `localhost:<port>`. See docs/config-schema.md for a worked example.
const sidecarSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'must be lowercase alphanumeric + dashes only'),
  image: z.string(),
  port: z.number().int().optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).default({}),
});

const resourceSpec = z
  .object({
    cpu: z.string().optional(),
    memory: z.string().optional(),
  })
  .optional();

// A single probe - defaults to a plain TCP check on the app's own `port` if `path` isn't given
// (see buildProbe() in manifestGen.js). Applies to the main app container only.
const probeSchema = z.object({
  path: z.string().optional(),
  initialDelaySeconds: z.number().int().optional(),
  periodSeconds: z.number().int().optional(),
});

const probesSchema = z
  .object({
    readiness: probeSchema.optional(),
    liveness: probeSchema.optional(),
  })
  .default({});

const appConfigSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'must be lowercase alphanumeric + dashes only'),
    subdomain: z.string().regex(/^[a-z0-9-]+$/).optional(),
    namespace: z.string().optional(),
    port: z.number().int(),
    build: z.object({
      context: z.string().default('.'),
      dockerfile: z.string().default('Dockerfile'),
    }),
    env: z.record(z.string()).default({}),
    // Names only - values never live here. Set with `localctl app secrets set <KEY>`, which
    // stores the value once as a real k8s Secret and injects it via secretKeyRef, the same
    // never-plaintext principle addon-provided credentials already follow.
    secrets: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be UPPER_SNAKE_CASE'))
      .default([]),
    replicas: z.number().int().min(1).default(1),
    resources: z
      .object({ requests: resourceSpec, limits: resourceSpec })
      .optional(),
    debug: debugSchema,
    probes: probesSchema,
    dependencies: z.array(dependencySchema).default([]),
    sidecars: z.array(sidecarSchema).default([]),
    sync: z.array(syncEntrySchema).default([]),
    tls: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    const overlap = cfg.secrets.filter((key) => key in cfg.env);
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secrets'],
        message: `${overlap.join(', ')} can't be in both "env" and "secrets" - pick one.`,
      });
    }
  });

module.exports = { appConfigSchema };

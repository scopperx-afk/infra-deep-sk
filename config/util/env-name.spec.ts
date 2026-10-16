import { envNameToPath, pathToEnvName } from './env-name';

describe('env-var name → dotted path (§5.1.1)', () => {
  it.each([
    ['DATABASE__POOL__MAX', 'database.pool.max'],
    ['RATE_LIMIT__DEFAULT__TTL_SECONDS', 'rateLimit.default.ttlSeconds'], // the spec's worked example
    ['MONGO__DB_NAME', 'mongo.dbName'],
    ['STORAGE__ACCESS_KEY_ID', 'storage.accessKeyId'],
    ['NODE_ENV', 'app.env'], // hardcoded special case
    ['S3__BUCKET_NAME', 's3.bucketName'],
  ])('%s → %s', (name, path) => {
    expect(envNameToPath(name)).toBe(path);
  });

  it.each([
    'PATH_',
    '_HOME',
    'A___B',
    'npm_config_cache',
    'lower__case',
    'A__',
    '__A',
    '',
  ])('rejects %j as a config key', (name) => {
    expect(envNameToPath(name)).toBeNull();
  });

  it('documents the catalog/algorithm mismatch for REDIS__PUBSUB_DB', () => {
    // The catalog (§13.5) names the key `redis.pubSubDb`, but the §5.1.1 algorithm turns
    // REDIS__PUBSUB_DB into `redis.pubsubDb`. `REDIS__PUB_SUB_DB` is what maps to pubSubDb.
    expect(envNameToPath('REDIS__PUBSUB_DB')).toBe('redis.pubsubDb');
    expect(envNameToPath('REDIS__PUB_SUB_DB')).toBe('redis.pubSubDb');
  });
});

describe('dotted path → env-var name (§11.5)', () => {
  it('reverses scalar paths', () => {
    expect(pathToEnvName(['database', 'pool', 'max'])).toBe(
      'DATABASE__POOL__MAX',
    );
    expect(pathToEnvName(['rateLimit', 'default', 'ttlSeconds'])).toBe(
      'RATE_LIMIT__DEFAULT__TTL_SECONDS',
    );
  });
  it('names NODE_ENV for app.env', () => {
    expect(pathToEnvName(['app', 'env'])).toBe('NODE_ENV');
  });
  it('uses the blob env var + JSON-pointer suffix inside arrays', () => {
    expect(pathToEnvName(['tokens', 'profiles', 0, 'secretRef'])).toBe(
      'TOKENS__PROFILES[0].secretRef',
    );
  });
});

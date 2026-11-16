// 从现有数据目录里把 DeepSeek 的 key 解出来，打印到标准输出（只用来给 eval 设环境变量，不落盘）。
// 用法：node eval/decrypt-key.mjs <数据目录> [供应商 id]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Secrets } from '../src/common/secrets.ts';

const [dataDir, providerId = 'deepseek'] = process.argv.slice(2);
if (!dataDir) {
	console.error('用法：node eval/decrypt-key.mjs <数据目录> [供应商 id]');
	process.exit(1);
}
const secrets = Secrets.fromFile(join(dataDir, 'secret-key'));
const config = JSON.parse(readFileSync(join(dataDir, 'models.json'), 'utf8'));
const provider = config.providers.find(item => item.id === providerId);
if (!provider) {
	console.error(`没有供应商 ${providerId}`);
	process.exit(1);
}
const key = provider.apiKey.startsWith('enc:') ? secrets.decrypt(provider.apiKey) : provider.apiKey;
if (!key) {
	console.error('解不开这个 key');
	process.exit(1);
}
process.stdout.write(key);

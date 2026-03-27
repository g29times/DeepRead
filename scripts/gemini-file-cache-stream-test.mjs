import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { GoogleGenAI } from '@google/genai';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { tries = 3, baseDelayMs = 800, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const delay = Math.round(baseDelayMs * Math.pow(2, i) + Math.random() * 200);
      console.error(`[${label}] failed (attempt ${i + 1}/${tries}):`, e && e.message ? e.message : e);
      if (i < tries - 1) {
        console.error(`[${label}] retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return '';
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const filePathArg = getArg('--file') || process.env.GEMINI_TEST_FILE || '';
  const ttlSeconds = Number(process.env.GEMINI_CACHE_TTL_SECONDS || '900');

  assert(apiKey, 'Missing GEMINI_API_KEY env');
  assert(filePathArg, 'Missing --file <path> or GEMINI_TEST_FILE env');

  const filePath = path.resolve(filePathArg);
  await fs.access(filePath);

  const client = new GoogleGenAI({ apiKey });

  let uploadedFile = null;
  let cache = null;

  try {
    uploadedFile = await withRetry(
      async () => {
        return await client.files.upload({
          file: filePath,
          config: {
            displayName: `deepread_test_${path.basename(filePath)}`,
          },
        });
      },
      { tries: 3, label: 'files.upload' }
    );

    console.log('[OK] upload:', {
      name: uploadedFile.name,
      uri: uploadedFile.uri,
      mimeType: uploadedFile.mimeType,
    });

    cache = await withRetry(
      async () => {
        return await client.caches.create({
          model,
          config: {
            displayName: `deepread_cache_${Date.now()}`,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: uploadedFile.uri,
                      mimeType: uploadedFile.mimeType,
                    },
                  },
                ],
              },
            ],
            systemInstruction: '你是一个专业的后端调试助手。请基于我提供的附件内容回答问题。',
            ttlSeconds,
          },
        });
      },
      { tries: 3, label: 'caches.create' }
    );

    console.log('[OK] cache:', { name: cache.name, model, ttlSeconds });

    const prompts = [
      '请用 10 条以内的要点总结该附件的主要内容结构。',
      '请列出你认为最值得我关注的 5 个异常/风险点（如果是日志/har，请偏向状态码、认证失败、重定向、cookie、安全敏感信息）。',
    ];

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      console.log(`\n[Q${i + 1}] ${prompt}`);

      const stream = await withRetry(
        async () => {
          return await client.models.generateContentStream({
            model,
            contents: prompt,
            config: {
              cached_content: cache.name,
            },
          });
        },
        { tries: 3, label: `generateContentStream#${i + 1}` }
      );

      let out = '';
      for await (const chunk of stream) {
        const t = (chunk && typeof chunk.text === 'function') ? chunk.text() : (chunk && chunk.text ? chunk.text : '');
        if (t) {
          out += t;
          process.stdout.write(t);
        }
      }
      console.log('\n' + '-'.repeat(60));

      if (!out.trim()) {
        throw new Error(`empty model output for Q${i + 1}`);
      }
    }

    console.log('\n[OK] done');
  } finally {
    if (cache && cache.name) {
      try {
        await withRetry(async () => await client.caches.delete(cache.name), { tries: 3, label: 'caches.delete' });
        console.log('[OK] cache deleted:', cache.name);
      } catch (e) {
        console.error('[WARN] cache delete failed:', e && e.message ? e.message : e);
      }
    }
  }
}

main().catch((e) => {
  console.error('[FATAL]', e && e.message ? e.message : e);
  process.exitCode = 1;
});

# -*- coding: utf-8 -*-
"""P4 Windows 可行性冒烟（lite 模式）：
1) 注入式 dummy embedder + HyMemoryClient(mode='lite') 全链路 add/search（验证 chromadb+kuzu 在 Windows 可用）
2) 无 embedder 时的启动行为（记录真实报错）
3) python -m hy_memory.server 启动尝试（记录）
全部输出打到 stdout，作为 docs/spike-p4.md 的证据。
"""
import asyncio, os, sys, time, tempfile, traceback

print('PY', sys.version.replace('\n', ' '))
print('CWD', os.getcwd())

fail = 0

# ---------- 1) dummy embedder + lite 全链路 ----------
class DummyEmbedder:
    """确定性哈希向量，仅冒烟用，不依赖任何网络。"""
    def __init__(self, dims=64):
        self.dims = dims
    def _vec(self, text):
        v = [0.0] * self.dims
        for i, ch in enumerate(text.encode('utf-8')):
            v[ch % self.dims] += 1.0 + (i % 7) * 0.1
        n = sum(x * x for x in v) ** 0.5 or 1.0
        return [x / n for x in v]
    async def embed(self, text, use_cache=True):
        return self._vec(text)
    async def embed_with_meta(self, text, use_cache=True):
        return self._vec(text), {'provider': 'dummy', 'dims': self.dims}
    async def embed_batch(self, texts, use_cache=True):
        return [self._vec(t) for t in texts]
    async def embed_queued(self, text, use_cache=True):
        return self._vec(text)
    async def embed_queued_with_meta(self, text, use_cache=True):
        return self._vec(text), {'provider': 'dummy', 'dims': self.dims}
    def get_embedding_dims(self):
        return self.dims

async def smoke_with_embedder():
    global fail
    print('=== [1] lite + injected embedder ===')
    data_dir = tempfile.mkdtemp(prefix='hy-smoke-')
    os.environ['MEMORY_DATA_DIR'] = data_dir
    os.environ['MEMORY_EMBEDDING_DIMS'] = '64'
    from hy_memory import HyMemoryClient
    t0 = time.time()
    cli = HyMemoryClient(mode='lite', embedding_service=DummyEmbedder(64))
    print('client init OK %.3fs data_dir=%s' % (time.time() - t0, data_dir))
    for txt in ['交接说明：服务端口 443 是 sing-box，绝对不能动', '构建脚本 build.ps1 会把产物复制到便携版目录']:
        t0 = time.time()
        cli.add(txt, user_id='smoke')
        print('add OK %.3fs len=%d' % (time.time() - t0, len(txt)))
    t0 = time.time()
    r = cli.search('服务端口 443 能不能动', user_ids=['smoke'], limit=3)
    dt = time.time() - t0
    print('search OK %.3fs' % dt)
    print('search result type=%s' % type(r).__name__)
    s = repr(r)
    print('search result head:', s[:500])
    t0 = time.time()
    lst = cli.list_memories(user_id='smoke')
    print('list OK %.3fs count_repr=%s' % (time.time() - t0, repr(lst)[:300]))
    cli.close()

def smoke_without_embedder():
    global fail
    print('=== [2] lite WITHOUT embedder ===')
    try:
        os.environ.pop('MEMORY_EMBEDDER_API_KEY', None)
        os.environ.pop('MEMORY_EMBEDDER_BASE_URL', None)
        os.environ.pop('OPENAI_API_KEY', None)
        from hy_memory import HyMemoryClient
        cli = HyMemoryClient(mode='lite')
        cli.add('test', user_id='smoke2')
        print('UNEXPECTED: init+add worked without embedder')
        cli.close()
    except Exception as e:
        print('EXPECTED-FAIL type=%s msg=%s' % (type(e).__name__, str(e)[:300]))

def smoke_server():
    print('=== [3] server startup attempt ===')
    import subprocess
    data_dir = tempfile.mkdtemp(prefix='hy-srv-')
    env = dict(os.environ)
    env['MEMORY_DATA_DIR'] = data_dir
    try:
        p = subprocess.Popen([sys.executable, '-m', 'hy_memory.server', '--port', '19527'],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        import urllib.request
        ok = False
        for _ in range(20):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen('http://127.0.0.1:19527/healthz', timeout=1) as r:
                    print('healthz:', r.status, r.read()[:100])
                    ok = True
                    break
            except Exception:
                pass
        if not ok:
            out = b''
            try:
                out = p.communicate(timeout=2)[0] or b''
            except Exception:
                p.kill()
                out = p.communicate()[0] or b''
            print('server NOT healthy; log tail:', out.decode('utf-8', 'replace')[:600])
        else:
            p.terminate()
            print('server startup OK (terminated after healthz)')
    except Exception as e:
        print('server smoke error:', type(e).__name__, str(e)[:200])

if __name__ == '__main__':
    try:
        asyncio.run(smoke_with_embedder())
    except Exception:
        fail += 1
        print('SMOKE1 EXCEPTION:')
        traceback.print_exc()
    try:
        smoke_without_embedder()
    except Exception:
        traceback.print_exc()
    try:
        smoke_server()
    except Exception:
        traceback.print_exc()
    print('SMOKE-DONE fail=%d' % fail)

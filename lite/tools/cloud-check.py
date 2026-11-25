import json, re, subprocess, sys

payload = json.load(sys.stdin)
address = payload['url']
headers = {}
sequence = 0

def request(method, params=None, notification=False):
    global sequence
    sequence += 1
    message = {'jsonrpc': '2.0', 'method': method}
    if not notification:
        message['id'] = sequence
    if params is not None:
        message['params'] = params
    args = ['curl', '--silent', '--show-error', '--max-time', '15', '--dump-header', '-', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream']
    for key, value in headers.items():
        args += ['-H', key + ': ' + value]
    args += ['--data-binary', json.dumps(message), address]
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError('CURL_NETWORK_ERROR')
    raw = result.stdout.replace('\r\n', '\n')
    response_headers, body = raw.split('\n\n', 1)
    status = int(response_headers.splitlines()[0].split()[1])
    if notification:
        if status not in (202, 204):
            raise RuntimeError('INITIALIZED_NOTIFICATION_FAILED')
        return None
    if status != 200:
        raise RuntimeError('HTTP_' + str(status))
    if body.lstrip().startswith('data:'):
        values = [json.loads(line[5:].strip()) for line in body.splitlines() if line.startswith('data:')]
        value = next(item for item in values if item.get('id') == sequence)
    else:
        value = json.loads(body)
    if 'error' in value:
        raise RuntimeError('JSON_RPC_ERROR')
    if method == 'initialize':
        match = re.search(r'^mcp-session-id:\s*(.+)$', response_headers, re.I | re.M)
        if match:
            headers['mcp-session-id'] = match.group(1).strip()
        headers['mcp-protocol-version'] = value['result']['protocolVersion']
    return value['result']

def tool(name, arguments):
    result = request('tools/call', {'name': name, 'arguments': arguments})
    if result.get('isError'):
        raise RuntimeError('TOOL_FAILED_' + name)
    text = '\n'.join(item['text'] for item in result['content'] if item.get('type') == 'text')
    try:
        return json.loads(text)
    except ValueError:
        return text

try:
    initial = request('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'cloud-end-to-end-verifier', 'version': '1.0'}})
    request('notifications/initialized', notification=True)
    tools = request('tools/list')['tools']
    tool('write_file', {'path': 'cloud-proof.txt', 'content': payload['marker'], 'why': 'Verify a real cloud request can write a local test file'})
    read = tool('read_file', {'path': 'cloud-proof.txt'})
    if payload['marker'] not in read['content']:
        raise RuntimeError('FILE_PROOF_MISMATCH')
    job = tool('job_start', {'command': 'Write-Output LBD_CLOUD_JOB_OK', 'why': 'Verify cloud execution returns the real local command output'})
    for attempt in range(3):
        output = tool('job_poll', {'id': job['id'], 'wait_ms': 3000})
        if output['status'] != 'running':
            break
    if output['exit_code'] != 0 or 'LBD_CLOUD_JOB_OK' not in output['output']:
        raise RuntimeError('COMMAND_PROOF_FAILED')
    tool('memory_set', {'key': 'cloud-proof', 'value': payload['marker'], 'kind': 'note'})
    context = tool('project_context', {})
    revision = int(re.search(r'当前修订号：(\d+)', context).group(1))
    tool('project_checkpoint', {'summary': '已从服务器通过公网实际完成本机文件读写、命令执行、记忆保存与概况更新。', 'next': '交付桌面 GUI 与多人客户端分发包。', 'risks': '尚未进行多台物理电脑和长期并发压力验证。', 'expected_revision': revision})
    memory = tool('memory_get', {'key': 'cloud-proof'})
    if memory['value'] != payload['marker']:
        raise RuntimeError('MEMORY_PROOF_FAILED')
    print(json.dumps({'ok': True, 'serverInfo': initial['serverInfo'], 'toolCount': len(tools), 'fileReadWrite': True, 'commandExecution': True, 'memoryPersistence': True, 'taskOverview': True}, ensure_ascii=True))
except Exception as error:
    print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'stage': str(error) if isinstance(error, RuntimeError) else 'Verification failed; private address omitted'}))
    sys.exit(1)

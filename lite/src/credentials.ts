import { createHmac } from 'node:crypto';
export function taskToken(master: string, taskId: string): string {
  return createHmac('sha256',master).update('liubendou-task:'+taskId).digest('hex');
}

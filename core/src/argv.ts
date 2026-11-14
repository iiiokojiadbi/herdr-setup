export interface Launch { parent: string; name: string; cwd: string; template?: string; task?: string; command?: string[]; labels?: Record<string,string> }
export const argv = {
  run(p: Launch): string[] {
    const args = ['run','--json','--bg','--parent',p.parent,'--name',p.name,'--cwd',p.cwd];
    for (const [key,value] of Object.entries(p.labels ?? {})) args.push('--label',`${key}=${value}`);
    return [...args, ...(p.command ? ['--',...p.command] : [p.template!,p.task!])];
  },
  ls: (includeFinished = false) => ['ls','--json', ...(includeFinished ? ['--all'] : [])],
  get: (address: string) => ['get','--json','--',address],
  send: (address: string, text: string) => ['send','--json','--',address,text],
  wait: (scope: {address?: string; children?: string}, timeoutMs: number) => ['wait','--json','--timeout',String(Math.ceil(timeoutMs / 1000)),...(scope.address ? ['--',scope.address] : ['--children',scope.children ?? 'any'])],
  read: (address: string, lines: number) => ['read','--json','--lines',String(lines),'--',address],
  kill: (address: string) => ['kill','--json','--',address],
  rm: (address: string) => ['rm','--json','--',address],
  templates: () => ['templates','--json'],
};

import * as vscode from 'vscode';
import { csp, esc, nonce } from './webviewSecurity';
import { parseTeamConnectionPlan, type TeamConnectionForm, type TeamConnectionPlan } from '../roles/TeamConnectionPlan';

/** One shared row editor for Setup guide and preset/custom creation. Selecting never discovers or starts a route. */
export function chooseTeamConnections(form: TeamConnectionForm, submitLabel: string, current: () => boolean,
  chooseModel?: (connectionId: string) => Promise<string | undefined>): Promise<TeamConnectionPlan | undefined> {
  const panel = vscode.window.createWebviewPanel('unode.teamConnections', 'Team connections & models', vscode.ViewColumn.Active, { enableScripts: true });
  panel.webview.html = teamConnectionsHtml(panel.webview, form, submitLabel, !!chooseModel);
  return new Promise(resolve => {
    let finished = false;
    const finish = (plan?: TeamConnectionPlan) => { if (finished) return; finished = true; resolve(plan); panel.dispose(); };
    panel.onDidDispose(() => { if (!finished) { finished = true; resolve(undefined); } });
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.command === 'cancel') { finish(); return; }
      if (message?.command === 'choose-model' && chooseModel) {
        if (!Number.isSafeInteger(message.roleIndex) || message.roleIndex < -1 || message.roleIndex >= form.roles.length
          || !Number.isSafeInteger(message.requestId) || message.requestId < 0
          || !form.connections.some(connection => connection.id === message.connectionId) || !current()) return;
        try {
          const model = await chooseModel(message.connectionId);
          if (model && !finished && current()) void panel.webview.postMessage({ command: 'model-choice', roleIndex: message.roleIndex,
            requestId: message.requestId, connectionId: message.connectionId, model });
        } catch { if (!finished) void panel.webview.postMessage({ command: 'error', text: 'Model choices could not be loaded. You can still type a model ID in its row.' }); }
        return;
      }
      if (message?.command !== 'save') return;
      try {
        if (!current()) throw new Error('The team changed while these choices were open. Reopen team creation to configure the current team.');
        finish(parseTeamConnectionPlan(message.plan, form));
      } catch (error) { void panel.webview.postMessage({ command: 'error', text: error instanceof Error ? error.message : 'Review the role choices.' }); }
    });
  });
}

export function teamConnectionsHtml(webview: vscode.Webview, form: TeamConnectionForm, submitLabel: string, browse = false): string {
  const scriptNonce = nonce(); const data = JSON.stringify(form).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}select,input{box-sizing:border-box;width:100%;min-width:0;padding:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}.role{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,2fr) auto;gap:8px;align-items:center;margin:10px 0}label{display:block;margin:10px 0 4px}.actions{display:flex;gap:8px;margin-top:16px}button{padding:6px 12px}p{line-height:1.5}#error{color:var(--vscode-errorForeground)}@media(max-width:480px){.role{grid-template-columns:minmax(0,1fr)}}</style></head><body>
<h2>Team connections & models</h2><p>Each role inherits the default until you change its row. These choices apply to the team being created; existing agents and your default connection stay as they are. Choosing here starts no program, sign-in or model request.</p>
<label for="defaultConnection">Default connection</label><select id="defaultConnection"></select>
<label for="defaultModel">Default model override (optional)</label><input id="defaultModel" placeholder="Use each role’s default model">${browse ? '<button id="browseDefault">Browse default model</button><p>Browse models uses local CLI choices, or this connection’s model metadata with its existing consent.</p>' : ''}<div id="roles"></div><p id="error" role="alert"></p>
<div class="actions"><button id="save">${esc(submitLabel)}</button><button id="cancel">Cancel</button></div>
<script nonce="${scriptNonce}">
const vscode=acquireVsCodeApi(); const form=${data}; const byId=id=>document.getElementById(id); const rows=[];const pending=new Map();let nextRequest=0;
function browseModel(index){const connectionId=index<0?byId('defaultConnection').value:rows[index].connection.value||byId('defaultConnection').value;const requestId=++nextRequest;pending.set(index,requestId);vscode.postMessage({command:'choose-model',roleIndex:index,connectionId,requestId});}
function option(select,value,label){const node=document.createElement('option');node.value=value;node.textContent=label;select.appendChild(node);}
for(const connection of form.connections)option(byId('defaultConnection'),connection.id,connection.label);
byId('defaultConnection').value=form.initial.connectionId; byId('defaultModel').value=form.initial.model||'';
for(const [index,role] of form.roles.entries()){
 const row=document.createElement('div');row.className='role';const label=document.createElement('span');label.textContent=role.label;
 const connection=document.createElement('select');connection.setAttribute('aria-label',role.label+' connection');option(connection,'','Use default connection');
 for(const item of form.connections)option(connection,item.id,item.label);
 const model=document.createElement('input');model.setAttribute('aria-label',role.label+' model');
 const chosen=(form.initial.roleConnections||[]).find(choice=>choice.roleIndex===index);
 connection.value=chosen?chosen.connectionId:'';model.value=chosen?.model||'';
 row.append(label,connection,model);byId('roles').appendChild(row);rows.push({connection,model});
 ${browse ? "const browse=document.createElement('button');browse.textContent='Browse models';browse.addEventListener('click',()=>browseModel(index));row.appendChild(browse);" : ''}
 model.addEventListener('input',()=>pending.delete(index));
}
function placeholders(){for(const [index,row] of rows.entries()){const id=row.connection.value||byId('defaultConnection').value;const connection=form.connections.find(item=>item.id===id);row.model.placeholder=(!row.connection.value||id===byId('defaultConnection').value?byId('defaultModel').value:'')||connection?.models[index]||'Enter model ID';}}
byId('defaultConnection').addEventListener('change',()=>{pending.clear();placeholders();});byId('defaultModel').addEventListener('input',()=>{pending.clear();placeholders();});for(const [index,row] of rows.entries())row.connection.addEventListener('change',()=>{pending.delete(index);placeholders();});placeholders();
${browse ? "byId('browseDefault').addEventListener('click',()=>browseModel(-1));" : ''}
byId('save').addEventListener('click',()=>{const base=byId('defaultConnection').value;const model=byId('defaultModel').value.trim();vscode.postMessage({command:'save',plan:{connectionId:base,...(model?{model}:{}),roleConnections:rows.flatMap((row,index)=>row.connection.value||row.model.value.trim()?[{roleIndex:index,roleKey:form.roles[index].roleKey,connectionId:row.connection.value||base,...(row.model.value.trim()?{model:row.model.value.trim()}:{})}]:[])}});});
byId('cancel').addEventListener('click',()=>vscode.postMessage({command:'cancel'}));window.addEventListener('message',event=>{const message=event.data;if(message?.command==='error')byId('error').textContent=message.text;if(message?.command==='model-choice'&&pending.get(message.roleIndex)===message.requestId){const currentId=message.roleIndex<0?byId('defaultConnection').value:rows[message.roleIndex]?.connection.value||byId('defaultConnection').value;if(currentId!==message.connectionId)return;pending.delete(message.roleIndex);if(message.roleIndex<0){pending.clear();byId('defaultModel').value=message.model;}else rows[message.roleIndex].model.value=message.model;placeholders();}});
</script></body></html>`;
}

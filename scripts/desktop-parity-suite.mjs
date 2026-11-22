import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// The exported suite is called by test-desktop's run-owned WebDriver harness.
// No production internals or private application object is accessed.
export async function parity(run, wd, fixtures) {
  const results=run.manifest.results;
  async function check(label,work){const result={label,status:'running',startedAt:new Date().toISOString()};results.push(result);await run.save();try{result.observed=await work();result.status='passed';}catch(error){result.status='failed';result.error=String(error?.message??error);throw error;}finally{result.finishedAt=new Date().toISOString();await run.save();}}
  async function menu(action){await wd.click(`button[data-action="${action}"]`);await wd.wait('menu opened','return !!document.querySelector("[role=menu]");');}
  async function selectText(css,text){await wd.clickText(css,text);}
  async function closeDialog(){await wd.keys(['\uE00C']);await wd.wait('dialog closed','return !document.querySelector("dialog[open]");');}
  async function commit(oid){await wd.click(`[id="commit-${oid}"]`);await wd.wait('commit detail ready','return !!document.querySelector(".details-pane:not([hidden]) .file-row");');}
  await check('inline details use an actual virtual-list slot',async()=>{
    await commit(fixtures.commits.keyboard);
    await wd.wait('inline row visible','return !!document.querySelector(".inline-detail-slot .details-pane:not([hidden])");');
    const geometry=await wd.script('const pane=document.querySelector(".inline-detail-slot");const grid=document.querySelector("[role=grid]");const cell=pane?.querySelector("[role=gridcell]");return {height:pane?.getBoundingClientRect().height,gridContains:grid?.contains(pane),cell:!!cell};');
    assert(geometry.height>=140);assert(geometry.gridContains);return geometry;
  });
  await check('explicit review starts and succeeds only on immutable commit content',async()=>{
    await wd.click('button[data-action="start-review"]');
    await wd.wait('review active','return !!document.querySelector("button[data-action=review-menu]");');
    const file=await wd.script('return document.querySelector(".file-row")?.dataset.path');
    await wd.click(`.file-row[data-path="${file}"]`);
    await wd.wait('viewed file marked','return document.querySelector(".file-row.reviewed")!==null;');
    await wd.click('button[data-action="review-menu"]');
    await wd.click('[role="menuitem"][data-action="end-review"]');
    await wd.wait('review can resume','return !!document.querySelector("button[data-action=resume-review]");');
    await wd.click('button[aria-label="Close details (Escape)"]');
    await wd.click('[id="commit-WORKTREE"]');
    await wd.wait('mutable details','return document.querySelector(".detail-title")?.textContent.includes("Working");');
    assert.equal(await wd.script('return document.querySelectorAll(".details-pane [data-action=start-review],.details-pane .review-check").length'),0);
    await wd.click('button[aria-label="Close details (Escape)"]');return {reviewedPath:file};
  });
  await check('annotated tag exposes its actual tagger and complete annotation',async()=>{
    const selector='.ref-tag';
    const tag=await wd.script('return [...document.querySelectorAll(arguments[0])].find(e=>e.textContent.includes("fixture-annotated"));',[selector]);
    assert(tag,'Annotated tag badge is present.');
    await wd.call('POST',`${wd.prefix}/actions`,{actions:[{type:'pointer',id:'tag-context',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',duration:0,origin:tag,x:1,y:1},{type:'pointerDown',button:2},{type:'pointerUp',button:2}]}]});
    await wd.call('DELETE',`${wd.prefix}/actions`);
    await wd.wait('tag context menu','return !!document.querySelector("[role=menu]");');
    const labels=await wd.script('return [...document.querySelectorAll("[role=menuitem]")].map(e=>e.textContent.trim());');
    const view=labels.find(label=>/tag.*detail|detail.*tag|tag.*metadata/i.test(label));assert(view,`Tag detail menu missing: ${labels}`);
    await wd.clickText('[role=menuitem]',view);
    await wd.wait('tag detail dialog','return !!document.querySelector("dialog[open]")?.innerText.includes("Fixture annotated tag");');
    const text=await wd.script('return document.querySelector("dialog[open]").innerText;');assert(text.includes('fixture@example.invalid'));assert(text.includes('Tag detail and review metadata.'));await closeDialog();return {text};
  });
  await check('named branch scope can restrict history and restore all',async()=>{
    await wd.click('button[data-action="scope"]');await wd.wait('scope dialog','return !!document.querySelector("dialog[open]");');
    await wd.select('dialog[open] select[name="scope"]','glob');
    await wd.fill('dialog[open] textarea[name="include"]','refs/heads/feature/workspace');
    await wd.fill('dialog[open] textarea[name="exclude"]','');
    const before=await wd.state();await wd.click('dialog[open] button[data-action="apply-history-scope"]');await wd.idle('glob scoped query complete',before.taskSequence);
    const scoped=await wd.script('return [...document.querySelectorAll(".commit-row")].map(row=>row.textContent);');
    assert(scoped.some(row=>row.includes('Persist workspace layout')));assert(!scoped.some(row=>row.includes('Add keyboard navigation')));
    await wd.click('button[data-action="scope"]');await wd.select('dialog[open] select[name="scope"]','all');
    const after=await wd.state();await wd.click('dialog[open] button[data-action="apply-history-scope"]');await wd.idle('all branches restored',after.taskSequence);
    return {scopedRows:scoped.length};
  });
  await check('settings expose new defaults and preserve trust-private separation',async()=>{
    await wd.click('button[data-action="settings"]');await wd.wait('settings','return !!document.querySelector(".settings-dialog[open]");');
    const available=await wd.script('return [...document.querySelectorAll(".settings-tabs [role=tab]")].map(e=>e.textContent);');
    assert(available.some(label=>/History|Query|Graph/i.test(label)));
    await wd.clickText('.settings-tabs [role=tab]','Messages & links');
    const markdown='[data-setting="markdown"] input';
    const control=await wd.script('const node=document.querySelector("[data-setting=markdown]");return {tag:node?.tagName,text:node?.outerHTML};');
    const selector=control.tag==='INPUT'?'input[data-setting="markdown"]':markdown;
    await wd.click(selector);
    await wd.click('button[data-action="save-settings"]');
    await wd.wait('settings save', 'return document.querySelector("[data-setting-status]")?.textContent.startsWith("All changes saved");');
    await closeDialog();
    await commit(fixtures.commits.keyboard);
    await wd.click('.message-body summary');
    await wd.wait('inline Markdown rendered as DOM not HTML','return !!document.querySelector(".message-body strong")?.textContent.includes("Markdown fixture");');
    const message=await wd.script('return {strong:document.querySelector(".message-body strong")?.textContent,links:[...document.querySelectorAll(".message-body a")].map(a=>a.href),text:document.querySelector(".message-body").textContent};');
    assert(message.links.some(url=>url==='https://example.invalid/review'));assert(message.text.includes('✨'));
    await wd.click('button[aria-label="Close details (Escape)"]');return {sections:available,message};
  });
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
  const report=process.argv[2];if(!report)throw new Error('This suite is invoked by the run-owned desktop harness, not by a global session.');
  const run=JSON.parse(await readFile(report,'utf8'));assert(run.schemaVersion===1);await writeFile(join(resolve(report,'..'),'parity-suite-ready.json'),JSON.stringify({ready:true},null,2));
}

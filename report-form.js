const OpenAI = require('openai');

let openai;
function getClient() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * steps 데이터를 양식에 맞게 시스템이 직접 조립
 * 0% 항목은 제외
 */
function assembleReportText(checkedTasks, extraMemo, reporterName) {
  const grouped = {};
  checkedTasks.forEach(t => {
    if (!grouped[t.projectName]) {
      grouped[t.projectName] = { tag: t.projectTag, tasks: [] };
    }
    grouped[t.projectName].tasks.push(t);
  });

  let body = '';
  let projNum = 1;

  Object.entries(grouped).forEach(([pName, pData]) => {
    body += `${projNum}. ${pName} / ${pData.tag}\n`;
    pData.tasks.forEach(t => {
      body += ` -. ${t.taskName}\n`;

      // steps가 있으면 0% 제외하고 번호 붙여 나열
      if (t.steps && t.steps.length > 0) {
        let stepNum = 1;
        t.steps.forEach(s => {
          let val = '';
          let pct = 0;
          if (s.type === 'check') {
            pct = s.done ? 100 : 0;
            val = s.done ? '완료' : '미완료';
          } else if (s.type === 'qty') {
            pct = s.target > 0 ? Math.round((s.current || 0) / s.target * 100) : 0;
            val = `${s.current || 0}/${s.target}개`;
          } else if (s.type === 'pct') {
            pct = s.pct || 0;
            val = `${pct}%`;
          }
          // 0%는 제외
          if (pct === 0) return;
          body += `   ${stepNum}) ${s.name} : ${val}\n`;
          stepNum++;
        });
      }

      // 메모 있으면 추가
      if (t.memo) {
        body += `   * ${t.memo}\n`;
      }
    });
    projNum++;
  });

  if (extraMemo) {
    body += `\n[추가사항]\n${extraMemo}\n`;
  }

  return body;
}

/**
 * GPT는 문장 표현만 다듬기 — 내용·구조·순서 변경 금지
 */
async function convertToReport(checkedTasks, extraMemo, reporterName, reporterTeam) {
  const today = new Date();
  const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const dateFullStr = `${today.getFullYear()}.${dateStr}`;

  // 1단계: 시스템이 직접 조립
  const assembled = assembleReportText(checkedTasks, extraMemo, reporterName);

  // 2단계: GPT는 문장 표현만 다듬기
  const systemPrompt = `당신은 출판사 직원의 일일업무보고 문장을 다듬는 도우미입니다.

[절대 규칙]
- 내용을 추가하거나 삭제하지 마세요.
- 항목 순서와 구조(번호, 들여쓰기)를 그대로 유지하세요.
- 0%이거나 없는 항목을 절대 추가하지 마세요.
- 오직 어색한 문장 표현과 어미만 자연스럽게 수정하세요.
- 경어체 사용: ~하였습니다, ~진행 중입니다, ~완료하였습니다, ~예정입니다
- 마지막에 반드시 다음 두 줄 추가:
  이상 업무에 참고하여 주시기 바랍니다.

  -${reporterName} 드림-
- JSON만 응답: { "subject": "제목", "body": "본문" }
- subject: "일일업무보고_${reporterTeam} ${reporterName} (${dateStr})"
- 마크다운 없이 순수 텍스트`;

  const completion = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `아래 업무 내용의 문장 표현만 자연스럽게 다듬어주세요:\n\n${assembled}` }
    ],
    temperature: 0.1,
  });

  const raw = completion.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  return {
    subject: parsed.subject,
    body: parsed.body,
    date: dateFullStr,
  };
}

module.exports = { convertToReport };

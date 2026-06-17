const OpenAI = require('openai');

let openai;
function getClient() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * 체크된 프로젝트/단위업무 목록을 성우 일일보고 양식으로 변환
 * @param {Array} checkedTasks - [{ projectName, projectTag, taskName, memo }]
 * @param {string} extraMemo - 추가 메모 (선택)
 * @param {string} reporterName
 * @param {string} reporterTeam
 */
async function convertToReport(checkedTasks, extraMemo, reporterName, reporterTeam) {
  const today = new Date();
  const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const dateFullStr = `${today.getFullYear()}.${dateStr}`;

  // 프로젝트별로 그룹핑
  const grouped = {};
  checkedTasks.forEach(t => {
    if (!grouped[t.projectName]) {
      grouped[t.projectName] = { tag: t.projectTag, tasks: [] };
    }
    grouped[t.projectName].tasks.push(t);
  });

  // GPT에 넘길 입력 정리
  let inputText = '';
  Object.entries(grouped).forEach(([pName, pData]) => {
    inputText += `\n[${pName} / ${pData.tag}]\n`;
    pData.tasks.forEach(t => {
      inputText += `- ${t.taskName}`;
      if (t.progress !== undefined && t.steps && t.steps.length > 0) {
        inputText += ` (진행률 ${t.progress}%)`;
        t.steps.forEach(s => {
          if (s.type === 'check') inputText += `\n  · ${s.name}: ${s.done ? '완료' : '미완료'}`;
          else if (s.type === 'qty') inputText += `\n  · ${s.name}: ${s.current || 0}/${s.target}개`;
          else if (s.type === 'pct') inputText += `\n  · ${s.name}: ${s.pct || 0}%`;
        });
      }
      if (t.memo) inputText += `\n  메모: ${t.memo}`;
      inputText += '\n';
    });
  });
  if (extraMemo) inputText += `\n[추가 메모]\n${extraMemo}\n`;

  const systemPrompt = `
당신은 출판사 직원의 일일업무보고 작성을 돕는 도우미입니다.
프로젝트별로 정리된 오늘의 업무 내용을 아래 양식으로 변환해주세요.

[양식 규칙]
- 프로젝트는 번호로 구분: "1. 프로젝트명관련"
- 세부 항목은 " -. 단위업무명" 형식
- 내용은 "  : 서술" 형식, 경어체 (~하였습니다, ~예정입니다, ~진행 중입니다)
- 메모가 있으면 내용에 자연스럽게 녹여서 작성
- 메모가 없으면 진행 중으로 서술
- 여러 단위업무는 "   1) 2) 3)" 넘버링
- 마지막에 반드시 "이상 업무에 참고하여 주시기 바랍니다.\n\n-${reporterName} 드림-" 추가
- JSON만 응답: { "subject": "제목", "body": "본문" }
- subject: "일일업무보고_${reporterTeam} ${reporterName} (${dateStr})"
- 마크다운 없이 순수 텍스트
`;

  const completion = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `오늘(${dateFullStr}) 업무:\n${inputText}` }
    ],
    temperature: 0.3,
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

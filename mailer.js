const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── 진행률 계산 ──────────────────────────────────────────
function calcStepProgress(step) {
  if (step.type === 'check') return step.done ? 100 : 0;
  if (step.type === 'qty')   return step.target > 0 ? Math.min(100, Math.round((step.current || 0) / step.target * 100)) : 0;
  if (step.type === 'pct')   return step.pct || 0;
  return 0;
}

function calcTaskProgress(task) {
  const steps = task.steps || [];
  if (!steps.length) return null; // steps 없으면 null (바 표시 안 함)
  const total = steps.reduce((s, step) => s + calcStepProgress(step), 0);
  return Math.round(total / steps.length);
}

function calcProjectProgress(project) {
  const tasks = project.tasks || [];
  if (!tasks.length) return 0;
  // steps 있는 task는 steps 기준, 없는 task는 0%로 계산
  const total = tasks.reduce((s, t) => {
    const p = calcTaskProgress(t);
    return s + (p !== null ? p : 0);
  }, 0);
  return Math.round(total / tasks.length);
}

// ── 색상 함수 ────────────────────────────────────────────
function barColor(p) {
  if (p === 0)   return '#ddd';
  if (p < 25)    return '#e74c3c';
  if (p < 50)    return '#e67e22';
  if (p < 75)    return '#3498db';
  return '#639922';
}

function ddayColor(d) {
  if (d === null) return '#888';
  if (d <= 3)  return '#e74c3c';
  if (d <= 7)  return '#e67e22';
  return '#888';
}

function calcDday(targetDate) {
  if (!targetDate) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(targetDate); target.setHours(0,0,0,0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// ── 날짜 포맷 ────────────────────────────────────────────
function formatDate() {
  const now = new Date();
  const days = ['일','월','화','수','목','금','토'];
  return `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
}

// ── HTML 이메일 생성 ─────────────────────────────────────
function buildHtmlEmail(report, reporterName, reporterTeam, checkedTasksRaw) {
  const dateStr = formatDate();
  const now = new Date();
  const dateShort = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;

  // checkedTasksRaw: [{ projectName, projectTag, taskName, progress, steps, memo }]
  // 프로젝트별 그룹핑
  const projectMap = {};
  (checkedTasksRaw || []).forEach(t => {
    if (!projectMap[t.projectName]) {
      projectMap[t.projectName] = {
        name: t.projectName,
        tag: t.projectTag || '',
        targetDate: t.targetDate || null,
        tasks: []
      };
    }
    projectMap[t.projectName].tasks.push(t);
  });
  const projects = Object.values(projectMap);

  // 요약 집계
  const totalTasks = (checkedTasksRaw || []).length;
  const nearestDday = projects.reduce((min, p) => {
    const d = calcDday(p.targetDate);
    if (d === null) return min;
    return min === null || d < min ? d : min;
  }, null);
  const nearestProject = projects.find(p => calcDday(p.targetDate) === nearestDday);

  // 본문 텍스트 → HTML (줄바꿈 처리)
  const normalizedBody = (report.body || '').replace(/\\n/g, '\n');
  const bodyLines = normalizedBody.split('\n');
  const bodyHtml = bodyLines.map(line => {
    const indent = line.match(/^( +)/);
    const paddingLeft = indent ? indent[1].length * 6 : 0;
    const content = line.trim();
    if (!content) return '<div style="min-height:0.6em">&nbsp;</div>';
    const isMain = /^\d+\./.test(content);
    const fontWeight = isMain ? '700' : '400';
    const color = isMain ? '#1a1a2e' : '#444';
    return `<div style="padding-left:${paddingLeft}px;min-height:1.7em;font-weight:${fontWeight};color:${color};">${content}</div>`;
  }).join('');

  // 프로젝트 진행률 카드 HTML
  const PROJECT_COLORS = ['#4285f4','#34a853','#ea4335','#fbbc04','#9c27b0'];
  let projectBarsHtml = '';
  projects.forEach((proj, pi) => {
    const pcolor = PROJECT_COLORS[pi % PROJECT_COLORS.length];
    const projProgress = Math.round(
      proj.tasks.reduce((s, t) => {
        const p = t.progress !== undefined ? t.progress : 0;
        return s + p;
      }, 0) / Math.max(proj.tasks.length, 1)
    );
    const barHeight = Math.max(4, Math.round(projProgress * 2.2));
    const dday = calcDday(proj.targetDate);
    const ddayStr = dday !== null ? `D-${dday}` : '';

    projectBarsHtml += `
      <td style="text-align:center;vertical-align:bottom;padding:0 6px;">
        <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${pcolor};">${projProgress}%</p>
        <table width="60%" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
          <tr><td style="background:${pcolor};height:${barHeight}px;border-radius:6px 6px 0 0;min-height:4px;display:block;"></td></tr>
        </table>
        <p style="margin:4px 0 0;font-size:11px;color:#555;word-break:keep-all;">${proj.name}</p>
        ${ddayStr ? `<p style="margin:2px 0 0;font-size:11px;color:${ddayColor(dday)};">${ddayStr}</p>` : ''}
      </td>`;
  });

  // 단위업무 진행률 바 HTML (steps 있는 것만)
  let taskBarsHtml = '';
  let hasTaskBars = false;
  (checkedTasksRaw || []).forEach(t => {
    if (t.progress === undefined || t.progress === null || !t.steps || !t.steps.length) return;
    hasTaskBars = true;
    const p = t.progress;
    const bc = barColor(p);
    taskBarsHtml += `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;">
        <tr>
          <td style="font-size:15px;font-weight:600;color:#1a1a2e;padding-bottom:6px;">${t.taskName}</td>
          <td align="right" style="font-size:15px;font-weight:700;color:${bc};padding-bottom:6px;">${p}%</td>
        </tr>
        <tr>
          <td colspan="2" style="background:#e8e8e8;border-radius:20px;height:22px;padding:0;overflow:hidden;">
            <div style="width:${p}%;background:${bc};height:22px;border-radius:20px;"></div>
          </td>
        </tr>
      </table>`;
  });

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f5f6fa;font-family:'Malgun Gothic','맑은 고딕',sans-serif;">

<!-- 헤더 바 -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a73e8;">
  <tr><td style="padding:16px 32px;">
    <span style="color:#fff;font-size:17px;font-weight:700;">도서출판 성우 &nbsp;·&nbsp; 일일업무보고</span>
  </td></tr>
</table>

<!-- 외부 컨테이너 -->
<table width="920" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f6fa" style="margin:24px auto;border-radius:14px;">
<tr><td style="padding:20px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-radius:14px;box-shadow:0 2px 14px rgba(0,0,0,0.08);">
<tr><td style="padding:46px;">

<!-- 제목 + 부제목 -->
<p style="margin:0 0 8px;font-size:34px;font-weight:700;color:#1a1a2e;">일일 업무 보고서</p>
<p style="margin:0 0 36px;font-size:17px;color:#888;">${dateStr} &nbsp;·&nbsp; 도서출판 성우 &nbsp;·&nbsp; ${reporterName || ''}</p>

<!-- 요약 카드 4개 -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;"><tr>
  <td width="23%" style="background:#f0f4ff;border-radius:12px;padding:26px 18px;text-align:center;">
    <p style="margin:0;font-size:15px;color:#666;">보고자</p>
    <p style="margin:10px 0 4px;font-size:28px;font-weight:700;color:#1a1a2e;">${reporterName || '-'}</p>
    <p style="margin:0;font-size:13px;color:#888;">${reporterTeam || ''}</p>
  </td><td width="2%"></td>
  <td width="23%" style="background:#f0fff4;border-radius:12px;padding:26px 18px;text-align:center;">
    <p style="margin:0;font-size:15px;color:#666;">오늘 업무</p>
    <p style="margin:10px 0 4px;font-size:54px;font-weight:700;color:#639922;">${totalTasks}</p>
    <p style="margin:0;font-size:13px;color:#888;">건</p>
  </td><td width="2%"></td>
  <td width="23%" style="background:#f0f7ff;border-radius:12px;padding:26px 18px;text-align:center;">
    <p style="margin:0;font-size:15px;color:#666;">보고 일자</p>
    <p style="margin:10px 0 4px;font-size:20px;font-weight:700;color:#378ADD;">${dateShort}</p>
    <p style="margin:0;font-size:13px;color:#888;">오늘</p>
  </td><td width="2%"></td>
  <td width="25%" style="background:#fff0f0;border-radius:12px;padding:26px 18px;text-align:center;border:2px solid #e74c3c;">
    <p style="margin:0;font-size:15px;color:#666;">가장 빠른 마감</p>
    <p style="margin:10px 0 6px;font-size:42px;font-weight:700;color:#e74c3c;">${nearestDday !== null ? `D-${nearestDday}` : '-'}</p>
    <p style="margin:0;font-size:13px;color:#e74c3c;">${nearestProject ? nearestProject.name : '-'}</p>
  </td>
</tr></table>

<!-- 보고 내용 -->
<hr style="border:none;border-top:1px solid #eee;margin:0 0 24px;">
<p style="margin:0 0 16px;font-size:21px;font-weight:700;color:#1a1a2e;">보고 내용</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
  <tr><td style="background:#f8f9fa;border-radius:10px;border:1px solid #e8e8e8;padding:24px;font-size:14px;line-height:1.9;color:#222;">
    ${bodyHtml}
  </td></tr>
</table>

<!-- 단위업무 진행률 | 프로젝트별 진행률 -->
<hr style="border:none;border-top:1px solid #eee;margin:0 0 28px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;">
<tr>
  <td width="46%"><p style="margin:0;font-size:21px;font-weight:700;color:#1a1a2e;">단위업무 진행률</p></td>
  <td width="8%"></td>
  <td width="46%"><p style="margin:0;font-size:21px;font-weight:700;color:#1a1a2e;">프로젝트별 진행률</p></td>
</tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr valign="top">
  <td width="46%">
    ${hasTaskBars ? taskBarsHtml : '<p style="font-size:14px;color:#aaa;">단계 정보가 있는 업무가 없습니다.</p>'}
  </td>
  <td width="8%"></td>
  <td width="46%" valign="bottom">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr valign="bottom">
        ${projectBarsHtml || '<td><p style="font-size:14px;color:#aaa;">-</p></td>'}
      </tr>
    </table>
  </td>
</tr>
</table>

<!-- 푸터 -->
<hr style="border:none;border-top:1px solid #eee;margin:24px 0 16px;">
<p style="margin:0;font-size:13px;color:#aaa;text-align:center;">이 보고서는 일일보고 자동화 시스템에서 발송되었습니다. &nbsp;·&nbsp; 도서출판 성우 ${reporterTeam || ''}</p>

</td></tr></table>
</td></tr></table>

</body>
</html>`;
}

async function sendReport(report, recipients, reporterName, reporterTeam, checkedTasksRaw) {
  const htmlBody = buildHtmlEmail(report, reporterName, reporterTeam, checkedTasksRaw);
  const result = await transporter.sendMail({
    from: `"${reporterName || process.env.REPORTER_NAME}" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject: report.subject,
    text: report.body,
    html: htmlBody,
  });
  return result;
}

async function verifyConnection() {
  return transporter.verify();
}

module.exports = { sendReport, verifyConnection, buildHtmlEmail };

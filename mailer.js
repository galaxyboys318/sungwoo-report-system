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

// exports는 하단에서 통합 관리

// ─── 주간보고 이메일 ───────────────────────────────────────
function buildWeeklyHtmlEmail(data, reporterName, reporterTeam) {
  const { weekStart, weekEnd, weeklyDays, aiSummary } = data;
  const fmt = d => { const [y,m,dd] = d.split('-'); return `${y}.${m}.${dd}`; };
  const dayNames = ['일','월','화','수','목','금','토'];
  const fmtDate = d => { const dt = new Date(d+'T00:00:00'); return `${fmt(d)} (${dayNames[dt.getDay()]})`; };
  const totalDays = weeklyDays.length;
  const totalTasks = weeklyDays.reduce((s, d) => s + d.entries.reduce((ss, e) => ss + (e.checkedTasks?.length || 0), 0), 0);

  // 프로젝트별 주간 집계
  const projectMap = {};
  weeklyDays.forEach(day => {
    day.entries.forEach(entry => {
      (entry.checkedTasks || []).forEach(task => {
        if (!projectMap[task.projectName]) projectMap[task.projectName] = { tasks: {}, tag: task.projectTag || '' };
        if (!projectMap[task.projectName].tasks[task.taskName]) {
          projectMap[task.projectName].tasks[task.taskName] = { dates: [], finalPct: 0 };
        }
        projectMap[task.projectName].tasks[task.taskName].dates.push(day.date);
        projectMap[task.projectName].tasks[task.taskName].finalPct = task.taskProgress || 0;
      });
    });
  });

  const projectCards = Object.entries(projectMap).map(([pName, pData]) => {
    const taskRows = Object.entries(pData.tasks).map(([tName, tData]) => `
      <tr>
        <td style="font-size:12px;color:#444;padding:6px 0 6px 14px;border-bottom:0.5px solid #f0f0f0;">
          ${tName}
          <span style="font-size:10px;color:#aaa;margin-left:6px;">${tData.dates.map(d => fmtDate(d)).join(', ')}</span>
        </td>
        <td align="right" style="font-size:12px;font-weight:500;color:#3498db;padding:6px 0;border-bottom:0.5px solid #f0f0f0;">
          ${tData.finalPct}%
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 8px 14px;">
          <div style="background:#e0e0e0;border-radius:20px;height:4px;overflow:hidden;">
            <div style="width:${tData.finalPct}%;background:#3498db;height:4px;border-radius:20px;"></div>
          </div>
        </td>
      </tr>`).join('');
    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;background:#f8fbff;border-radius:10px;border:1.5px solid #c8d8f8;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#1a1a2e;">${pName}
            <span style="margin-left:8px;font-size:10px;background:#e8f0fe;color:#1558b0;padding:2px 7px;border-radius:20px;">${pData.tag}</span>
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">${taskRows}</table>
        </td></tr>
      </table>`;
  }).join('');

  const dayRows = weeklyDays.map(day => `
    <tr>
      <td style="padding:10px 0;border-bottom:0.5px solid #f0f0f0;vertical-align:top;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:500;color:#1a73e8;">${fmtDate(day.date)}</p>
        ${day.entries.map(e => `<p style="margin:0;font-size:12px;color:#444;white-space:pre-line;line-height:1.8;">${e.body}</p>`).join('')}
      </td>
    </tr>`).join('');

  return `
<table width="660" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f6fa" style="margin:24px auto;border-radius:14px;font-family:'Malgun Gothic',sans-serif;">
<tr><td style="background:#1a73e8;border-radius:14px 14px 0 0;padding:14px 28px;">
  <span style="color:#fff;font-size:15px;font-weight:500;">도서출판 성우 &nbsp;·&nbsp; 주간업무보고</span>
</td></tr>
<tr><td style="background:#fff;border-radius:0 0 14px 14px;padding:28px 32px;">

  <p style="margin:0 0 4px;font-size:22px;font-weight:500;color:#1a1a2e;">주간 업무 보고서</p>
  <p style="margin:0 0 24px;font-size:12px;color:#aaa;">${fmt(weekStart)} ~ ${fmt(weekEnd)} &nbsp;·&nbsp; ${reporterName} &nbsp;·&nbsp; ${reporterTeam}</p>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr>
    <td width="30%" style="background:#f0f4ff;border-radius:10px;padding:16px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#666;">보고 일수</p>
      <p style="margin:8px 0 2px;font-size:30px;font-weight:500;color:#1a73e8;">${totalDays}</p>
      <p style="margin:0;font-size:10px;color:#888;">일</p>
    </td>
    <td width="4%"></td>
    <td width="30%" style="background:#f0fff4;border-radius:10px;padding:16px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#666;">총 업무</p>
      <p style="margin:8px 0 2px;font-size:30px;font-weight:500;color:#639922;">${totalTasks}</p>
      <p style="margin:0;font-size:10px;color:#888;">건</p>
    </td>
    <td width="4%"></td>
    <td width="32%" style="background:#fef7e0;border-radius:10px;padding:16px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#666;">관여 프로젝트</p>
      <p style="margin:8px 0 2px;font-size:30px;font-weight:500;color:#b06000;">${Object.keys(projectMap).length}</p>
      <p style="margin:0;font-size:10px;color:#888;">개</p>
    </td>
  </tr></table>

  <hr style="border:none;border-top:0.5px solid #eee;margin:0 0 18px;">
  <p style="margin:0 0 14px;font-size:15px;font-weight:500;color:#1a1a2e;">프로젝트별 주간 진행 현황</p>
  ${projectCards}

  <hr style="border:none;border-top:0.5px solid #eee;margin:4px 0 18px;">
  <p style="margin:0 0 14px;font-size:15px;font-weight:500;color:#1a1a2e;">AI 주간 요약</p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
    <tr><td style="background:#f8f9fa;border-radius:8px;border:0.5px solid #e8e8e8;padding:16px 18px;font-size:13px;line-height:1.9;color:#222;white-space:pre-line;">${aiSummary || '요약 없음'}</td></tr>
  </table>

  <hr style="border:none;border-top:0.5px solid #eee;margin:0 0 14px;">
  <p style="margin:0 0 14px;font-size:15px;font-weight:500;color:#1a1a2e;">일자별 상세 내역</p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">${dayRows}</table>

  <hr style="border:none;border-top:0.5px solid #eee;margin:0 0 12px;">
  <p style="margin:0;font-size:11px;color:#aaa;text-align:center;">이 보고서는 일일보고 자동화 시스템에서 발송되었습니다. &nbsp;·&nbsp; 도서출판 성우 솔루션개발팀</p>

</td></tr></table>`;
}

async function sendWeeklyReport(data, recipients, reporterName, reporterTeam) {
  const { weekStart, weekEnd } = data;
  const fmt = d => { const [y,m,dd] = d.split('-'); return `${m}.${dd}`; };
  const htmlBody = buildWeeklyHtmlEmail(data, reporterName, reporterTeam);
  return transporter.sendMail({
    from: `"${reporterName} (${reporterTeam})" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject: `[주간보고] ${reporterTeam} ${reporterName} (${fmt(weekStart)}~${fmt(weekEnd)})`,
    html: htmlBody,
  });
}

module.exports = { sendReport, sendWeeklyReport, verifyConnection, buildHtmlEmail, buildWeeklyHtmlEmail };

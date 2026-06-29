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
  const now = new Date();
  const dateShort = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;

  // 프로젝트별 그룹핑
  const projectMap = {};
  (checkedTasksRaw || []).forEach(t => {
    if (!projectMap[t.projectName]) {
      projectMap[t.projectName] = { name: t.projectName, tag: t.projectTag || '', targetDate: t.targetDate || null, tasks: [] };
    }
    projectMap[t.projectName].tasks.push(t);
  });
  const projects = Object.values(projectMap);
  const totalTasks = (checkedTasksRaw || []).length;

  // 가장 빠른 마감
  const nearestDday = projects.reduce((min, p) => {
    const d = calcDday(p.targetDate);
    if (d === null) return min;
    return min === null || d < min ? d : min;
  }, null);
  const nearestProject = projects.find(p => calcDday(p.targetDate) === nearestDday);

  // 본문 HTML
  const normalizedBody = (report.body || '').replace(/\\n/g, '\n');
  const bodyHtml = normalizedBody.split('\n').map(line => {
    const indent = line.match(/^( +)/);
    const paddingLeft = indent ? indent[1].length * 6 : 0;
    const content = line.trim();
    if (!content) return '<div style="min-height:0.6em">&nbsp;</div>';
    const isMain = /^\d+\./.test(content);
    return `<div style="padding-left:${paddingLeft}px;min-height:1.7em;font-weight:${isMain?'600':'400'};color:${isMain?'#1a1a2e':'#444'};">${content}</div>`;
  }).join('');

  // 프로젝트별 진행 현황 카드 (오늘 보고한 것만)
  const PROJECT_COLORS = [
    { bg:'#f8fbff', border:'#c8d8f8', proj:'#4285f4', task:'#3498db' },
    { bg:'#f6fff8', border:'#b2dfdb', proj:'#34a853', task:'#3498db' },
    { bg:'#fff8f0', border:'#ffe0b2', proj:'#e67e22', task:'#3498db' },
    { bg:'#fdf0ff', border:'#e1bee7', proj:'#9c27b0', task:'#3498db' },
  ];

  const projectCardsHtml = projects.map((proj, pi) => {
    const c = PROJECT_COLORS[pi % PROJECT_COLORS.length];
    const projProgress = Math.round(
      proj.tasks.reduce((s, t) => s + (t.taskProgress || t.progress || 0), 0) / Math.max(proj.tasks.length, 1)
    );
    const dday = calcDday(proj.targetDate);

    // 단위업무별 행
    const taskRows = proj.tasks.map(t => {
      const tp = t.taskProgress || t.progress || 0;

      // 오늘 체크한 단계만 필터
      const todaySteps = (t.steps || []).filter(s => s.checkedToday);
      const stepRows = todaySteps.map(s => {
        let statusStr = '';
        let statusColor = '#e67e22';
        let barPct = 0;
        if (s.type === 'check') {
          statusStr = s.done ? '완료' : '미완';
          statusColor = s.done ? '#34a853' : '#aaa';
          barPct = s.done ? 100 : 0;
        } else if (s.type === 'pct') {
          statusStr = `${s.pct || 0}%`;
          barPct = s.pct || 0;
        } else if (s.type === 'qty') {
          statusStr = `${s.current || 0} / ${s.target || 0}`;
          barPct = s.target ? Math.round((s.current || 0) / s.target * 100) : 0;
          statusColor = '#34a853';
        }
        const stepBarColor = s.done || barPct >= 100 ? '#34a853' : '#e67e22';
        const memoHtml = s.memo ? `<div style="font-size:10px;color:#888;padding-left:18px;margin-top:1px;line-height:1.5;">${s.memo}</div>` : '';
        return `
          <tr>
            <td style="padding:4px 0 0 14px;font-size:11px;color:#666;">${s.name}</td>
            <td align="right" style="padding:4px 0 0;font-size:11px;font-weight:500;color:${statusColor};white-space:nowrap;">${statusStr}</td>
          </tr>
          <tr><td colspan="2" style="padding:2px 0 6px 14px;">
            <div style="background:#e0e0e0;border-radius:20px;height:3px;overflow:hidden;">
              <div style="width:${barPct}%;background:${stepBarColor};height:3px;border-radius:20px;"></div>
            </div>
            ${memoHtml}
          </td></tr>`;
      }).join('');

      const stepsBox = todaySteps.length > 0 ? `
        <tr><td colspan="2" style="padding:4px 0 6px 0;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:6px;border:0.5px solid ${c.border};padding:6px 10px;">
            <tr><td colspan="2" style="padding:4px 0 2px;font-size:10px;font-weight:600;color:${c.proj};">단계별 진행</td></tr>
            ${stepRows}
          </table>
        </td></tr>` : '';

      return `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;">
          <tr>
            <td style="font-size:13px;font-weight:500;color:#1a1a2e;padding-bottom:3px;">${t.taskName}</td>
            <td align="right" style="font-size:13px;font-weight:600;color:${c.task};padding-bottom:3px;">${tp}%</td>
          </tr>
          <tr><td colspan="2" style="padding-bottom:${todaySteps.length>0?'6':'0'}px;">
            <div style="background:#e0e0e0;border-radius:20px;height:5px;overflow:hidden;">
              <div style="width:${tp}%;background:${c.task};height:5px;border-radius:20px;"></div>
            </div>
          </td></tr>
          ${stepsBox}
        </table>`;
    }).join('');

    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;background:${c.bg};border-radius:10px;border:1.5px solid ${c.border};">
      <tr><td style="padding:14px 18px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
          <tr>
            <td>
              <span style="font-size:14px;font-weight:500;color:#1a1a2e;">${proj.name}</span>
              <span style="margin-left:8px;font-size:10px;background:#e8f0fe;color:#1558b0;padding:2px 7px;border-radius:20px;font-weight:500;">${proj.tag}</span>
              ${dday !== null ? `<span style="margin-left:6px;font-size:10px;color:${ddayColor(dday)};">D-${dday}</span>` : ''}
            </td>
            <td align="right" style="font-size:16px;font-weight:600;color:${c.proj};">${projProgress}%</td>
          </tr>
        </table>
        <div style="background:#e0e0e0;border-radius:20px;height:6px;overflow:hidden;margin-bottom:12px;">
          <div style="width:${projProgress}%;background:${c.proj};height:6px;border-radius:20px;"></div>
        </div>
        ${taskRows}
      </td></tr></table>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f6fa;font-family:'Malgun Gothic','맑은 고딕',sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a73e8;">
  <tr><td style="padding:14px 28px;">
    <span style="color:#fff;font-size:15px;font-weight:500;">도서출판 성우 &nbsp;·&nbsp; 일일업무보고</span>
  </td></tr>
</table>

<table width="660" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f6fa" style="margin:20px auto;border-radius:14px;">
<tr><td style="padding:16px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-radius:12px;">
<tr><td style="padding:28px 32px;">

<p style="margin:0 0 24px;font-size:22px;font-weight:500;color:#1a1a2e;">일일 업무 보고서</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr>
  <td width="23%" style="background:#f0f4ff;border-radius:10px;padding:16px 12px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#666;">보고자</p>
    <p style="margin:7px 0 2px;font-size:17px;font-weight:500;color:#1a1a2e;">${reporterName||'-'}</p>
    <p style="margin:0;font-size:10px;color:#888;">${reporterTeam||''}</p>
  </td><td width="2%"></td>
  <td width="23%" style="background:#f0fff4;border-radius:10px;padding:16px 12px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#666;">오늘 업무</p>
    <p style="margin:7px 0 2px;font-size:32px;font-weight:500;color:#639922;">${totalTasks}</p>
    <p style="margin:0;font-size:10px;color:#888;">건</p>
  </td><td width="2%"></td>
  <td width="23%" style="background:#f0f7ff;border-radius:10px;padding:16px 12px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#666;">보고 일자</p>
    <p style="margin:7px 0 2px;font-size:14px;font-weight:500;color:#378ADD;">${dateShort}</p>
    <p style="margin:0;font-size:10px;color:#888;">오늘</p>
  </td><td width="2%"></td>
  <td width="25%" style="background:#fff0f0;border-radius:10px;padding:16px 12px;text-align:center;border:1.5px solid #e74c3c;">
    <p style="margin:0;font-size:11px;color:#666;">가장 빠른 마감</p>
    <p style="margin:7px 0 4px;font-size:26px;font-weight:500;color:#e74c3c;">${nearestDday!==null?`D-${nearestDday}`:'-'}</p>
    <p style="margin:0;font-size:10px;color:#e74c3c;">${nearestProject?nearestProject.name:'-'}</p>
  </td>
</tr></table>

<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 18px;">
<p style="margin:0 0 14px;font-size:15px;font-weight:500;color:#1a1a2e;">프로젝트 진행 현황</p>
${projectCardsHtml || '<p style="font-size:13px;color:#aaa;">진행 중인 프로젝트가 없습니다.</p>'}

<hr style="border:none;border-top:0.5px solid #eee;margin:4px 0 18px;">
<p style="margin:0 0 12px;font-size:15px;font-weight:500;color:#1a1a2e;">보고 내용</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
  <tr><td style="background:#f8f9fa;border-radius:8px;border:0.5px solid #e8e8e8;padding:16px 18px;font-size:13px;line-height:1.9;color:#222;">
    ${bodyHtml}
  </td></tr>
</table>

<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 12px;">
<p style="margin:0;font-size:11px;color:#aaa;text-align:center;">이 보고서는 일일보고 자동화 시스템에서 발송되었습니다. &nbsp;·&nbsp; 도서출판 성우 ${reporterTeam||''}</p>

</td></tr></table>
</td></tr></table>

</body></html>`;
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

// exports 통합 관리 (하단)

// ─── 분기보고 이메일 ───────────────────────────────────────
function buildQuarterlyHtmlEmail(data, reporterName, reporterTeam) {
  const { year, quarter, weeklyRecords, projectTrend, aiSummary } = data;
  const qLabel = `${year}년 ${quarter}분기`;
  const totalWeeks = (weeklyRecords || []).length;
  const totalDays = (weeklyRecords || []).reduce((s, r) => s + (r.weeklyDays || []).length, 0);

  const projectRows = Object.entries(projectTrend || {}).map(([pName, pData]) => {
    const weeks = pData.weeks || [];
    const first = weeks[0]?.progress ?? 0;
    const last = weeks[weeks.length - 1]?.progress ?? 0;
    const diff = last - first;
    const diffStr = diff > 0 ? `▲${diff}%` : diff < 0 ? `▼${Math.abs(diff)}%` : '–';
    const diffColor = diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#888';
    return `<tr>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:13px;color:#1a1a2e;">${pName}</td>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;color:#888;">${pData.tag || ''}</td>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:13px;font-weight:500;color:#2563eb;">${last}%</td>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:12px;font-weight:500;color:${diffColor};">${diffStr}</td>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;color:#888;">${totalWeeks}주</td>
    </tr>`;
  }).join('');

  const weekRows = (weeklyRecords || []).map(r => `
    <tr>
      <td style="padding:7px 12px;border:0.5px solid #e8e8e8;font-size:12px;color:#555;">${r.weekKey}</td>
      <td style="padding:7px 12px;border:0.5px solid #e8e8e8;font-size:12px;color:#444;line-height:1.7;">${(r.aiSummary || '').replace(/\n/g,'<br>')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f6fa;font-family:'Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#2563eb;"><tr><td style="padding:14px 28px;">
  <span style="color:#fff;font-size:15px;font-weight:500;">도서출판 성우 &nbsp;·&nbsp; 분기업무보고</span>
</td></tr></table>
<table width="660" cellpadding="0" cellspacing="0" style="margin:20px auto;background:#fff;border-radius:12px;">
<tr><td style="padding:28px 32px;">
<p style="margin:0 0 4px;font-size:22px;font-weight:500;color:#1a1a2e;">${qLabel} 업무 보고서</p>
<p style="margin:0 0 22px;font-size:12px;color:#aaa;">${reporterName} &nbsp;·&nbsp; ${reporterTeam}</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;"><tr>
  <td width="30%" style="background:#f0f4ff;border-radius:10px;padding:14px;text-align:center;"><p style="margin:0;font-size:11px;color:#666;">보고 주수</p><p style="margin:6px 0;font-size:26px;font-weight:500;color:#2563eb;">${totalWeeks}</p><p style="margin:0;font-size:10px;color:#888;">주</p></td>
  <td width="5%"></td>
  <td width="30%" style="background:#f0fff4;border-radius:10px;padding:14px;text-align:center;"><p style="margin:0;font-size:11px;color:#666;">총 보고 일수</p><p style="margin:6px 0;font-size:26px;font-weight:500;color:#16a34a;">${totalDays}</p><p style="margin:0;font-size:10px;color:#888;">일</p></td>
  <td width="5%"></td>
  <td width="30%" style="background:#fef7e0;border-radius:10px;padding:14px;text-align:center;"><p style="margin:0;font-size:11px;color:#666;">관여 프로젝트</p><p style="margin:6px 0;font-size:26px;font-weight:500;color:#b06000;">${Object.keys(projectTrend||{}).length}</p><p style="margin:0;font-size:10px;color:#888;">개</p></td>
</tr></table>
<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 16px;">
<p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#1a1a2e;">프로젝트별 분기 진행 현황</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border-collapse:collapse;">
  <tr style="background:#f8f9fa;"><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;text-align:left;color:#666;">프로젝트</th><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;color:#666;">구분</th><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;color:#666;">현재</th><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;color:#666;">분기 변화</th><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;color:#666;">기간</th></tr>
  ${projectRows || '<tr><td colspan="5" style="padding:12px;text-align:center;color:#aaa;font-size:12px;">데이터 없음</td></tr>'}
</table>
<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 16px;">
<p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#1a1a2e;">주차별 요약</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border-collapse:collapse;">
  <tr style="background:#f8f9fa;"><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;text-align:left;color:#666;width:15%;">주차</th><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;text-align:left;color:#666;">내용</th></tr>
  ${weekRows || '<tr><td colspan="2" style="padding:12px;text-align:center;color:#aaa;font-size:12px;">주간보고 데이터 없음</td></tr>'}
</table>
<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 16px;">
<p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#1a1a2e;">AI 분기 요약</p>
<div style="background:#f8f9fa;border-radius:8px;padding:16px;font-size:13px;line-height:1.9;color:#222;white-space:pre-line;">${aiSummary || '요약 없음'}</div>
<hr style="border:none;border-top:0.5px solid #eee;margin:18px 0 12px;">
<p style="margin:0;font-size:11px;color:#aaa;text-align:center;">도서출판 성우 ${reporterTeam} · 일일보고 자동화 시스템</p>
</td></tr></table></body></html>`;
}

async function sendQuarterlyReport(data, recipients, reporterName, reporterTeam) {
  const { year, quarter } = data;
  const html = buildQuarterlyHtmlEmail(data, reporterName, reporterTeam);
  return transporter.sendMail({
    from: `"${reporterName} (${reporterTeam})" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject: `[분기보고] ${reporterTeam} ${reporterName} (${year}년 ${quarter}분기)`,
    html,
  });
}

// ─── 연말보고 이메일 ───────────────────────────────────────
function buildAnnualHtmlEmail(data, reporterName, reporterTeam) {
  const { year, quarterlyRecords, aiSummary } = data;
  const qRows = (quarterlyRecords || []).map(r => `
    <tr>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:13px;color:#1a1a2e;font-weight:500;">${r.year}년 ${r.quarter}분기</td>
      <td style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:12px;color:#444;line-height:1.7;">${(r.aiSummary || '').replace(/\n/g,'<br>')}</td>
    </tr>`).join('');

  const totalWeeks = (quarterlyRecords || []).reduce((s, r) => s + (r.weeklyRecords || []).length, 0);

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f6fa;font-family:'Malgun Gothic',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1e2e;"><tr><td style="padding:14px 28px;">
  <span style="color:#fff;font-size:15px;font-weight:500;">도서출판 성우 &nbsp;·&nbsp; 연간업무보고</span>
</td></tr></table>
<table width="660" cellpadding="0" cellspacing="0" style="margin:20px auto;background:#fff;border-radius:12px;">
<tr><td style="padding:28px 32px;">
<p style="margin:0 0 4px;font-size:22px;font-weight:500;color:#1a1a2e;">${year}년 연간 업무 보고서</p>
<p style="margin:0 0 22px;font-size:12px;color:#aaa;">${reporterName} &nbsp;·&nbsp; ${reporterTeam}</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;"><tr>
  <td width="30%" style="background:#f0f4ff;border-radius:10px;padding:14px;text-align:center;"><p style="margin:0;font-size:11px;color:#666;">보고 분기</p><p style="margin:6px 0;font-size:26px;font-weight:500;color:#1e1e2e;">${(quarterlyRecords||[]).length}</p><p style="margin:0;font-size:10px;color:#888;">분기</p></td>
  <td width="5%"></td>
  <td width="30%" style="background:#f0fff4;border-radius:10px;padding:14px;text-align:center;"><p style="margin:0;font-size:11px;color:#666;">총 보고 주수</p><p style="margin:6px 0;font-size:26px;font-weight:500;color:#16a34a;">${totalWeeks}</p><p style="margin:0;font-size:10px;color:#888;">주</p></td>
  <td width="5%"></td>
  <td width="30%" style="background:#fef7e0;border-radius:10px;padding:14px;text-align:center;"><p style="margin:0;font-size:11px;color:#666;">보고 연도</p><p style="margin:6px 0;font-size:26px;font-weight:500;color:#b06000;">${year}</p><p style="margin:0;font-size:10px;color:#888;">년</p></td>
</tr></table>
<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 16px;">
<p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#1a1a2e;">분기별 요약</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border-collapse:collapse;">
  <tr style="background:#f8f9fa;"><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;text-align:left;color:#666;width:18%;">분기</th><th style="padding:8px 12px;border:0.5px solid #e8e8e8;font-size:11px;text-align:left;color:#666;">주요 성과</th></tr>
  ${qRows || '<tr><td colspan="2" style="padding:12px;text-align:center;color:#aaa;font-size:12px;">분기보고 데이터 없음</td></tr>'}
</table>
<hr style="border:none;border-top:0.5px solid #eee;margin:0 0 16px;">
<p style="margin:0 0 10px;font-size:14px;font-weight:500;color:#1a1a2e;">AI 연간 요약</p>
<div style="background:#f8f9fa;border-radius:8px;padding:16px;font-size:13px;line-height:1.9;color:#222;white-space:pre-line;">${aiSummary || '요약 없음'}</div>
<hr style="border:none;border-top:0.5px solid #eee;margin:18px 0 12px;">
<p style="margin:0;font-size:11px;color:#aaa;text-align:center;">도서출판 성우 ${reporterTeam} · 일일보고 자동화 시스템</p>
</td></tr></table></body></html>`;
}

async function sendAnnualReport(data, recipients, reporterName, reporterTeam) {
  const { year } = data;
  const html = buildAnnualHtmlEmail(data, reporterName, reporterTeam);
  return transporter.sendMail({
    from: `"${reporterName} (${reporterTeam})" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject: `[연간보고] ${reporterTeam} ${reporterName} (${year}년)`,
    html,
  });
}

module.exports = { sendReport, sendWeeklyReport, sendQuarterlyReport, sendAnnualReport, verifyConnection, buildHtmlEmail, buildWeeklyHtmlEmail, buildQuarterlyHtmlEmail, buildAnnualHtmlEmail };

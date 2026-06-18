require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { convertToReport } = require('./report-form');
const { sendReport, verifyConnection, buildHtmlEmail } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sungwoo-report-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8시간
}));
app.use(express.static(path.join(__dirname, 'views')));

// ─── 인증 미들웨어 ───────────────────────────────────────
const USERS_PATH = path.join(__dirname, 'data', 'users.json');

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).json({ error: '관리자 권한이 필요합니다.' });
}

// ─── 로그인 API ──────────────────────────────────────────

// 현재 로그인 유저 정보
app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// 로그인
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.email === email && u.password === password);
  if (!user) return res.json({ success: false, message: '이메일 또는 비밀번호가 올바르지 않습니다.' });

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    level: user.level || 4,
    position: user.position || '팀원',
    team: user.team || '',
    division: user.division || '',
  };
  res.json({ success: true, redirect: '/report' });
});

// 로그아웃
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── 사용자 관리 API (관리자 전용) ──────────────────────

function saveUsers(data) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/recipients', requireLogin, (req, res) => {
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  // 레벨 1~2 (팀장/임원급)만 수신자로 노출, 비밀번호 제외
  const recipients = data.users
    .filter(u => u.level <= 2)
    .map(({ password, ...u }) => u);
  res.json({ recipients });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  // 비밀번호 제외하고 응답
  const users = data.users.map(({ password, ...u }) => u);
  res.json({ users });
});

app.post('/api/users/add', requireAdmin, (req, res) => {
  const { name, email, password, role, team, division, position, level } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: '필수값 누락' });
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  if (data.users.find(u => u.email === email)) return res.status(400).json({ error: '이미 존재하는 이메일' });
  data.users.push({ id: `u${Date.now()}`, name, email, password, role: role || 'user', position: position || '팀원', level: level || 4, team: team || '', division: division || '' });
  saveUsers(data);
  res.json({ success: true });
});

app.post('/api/users/delete', requireAdmin, (req, res) => {
  const { userId } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  data.users = data.users.filter(u => u.id !== userId);
  saveUsers(data);
  res.json({ success: true });
});

app.post('/api/users/password', requireAdmin, (req, res) => {
  const { userId, newPassword } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.password = newPassword;
  saveUsers(data);
  res.json({ success: true });
});

// ─── 프로젝트 데이터 ────────────────────────────────────
const PROJECTS_PATH = path.join(__dirname, 'data', 'projects.json');

app.get('/api/projects', (req, res) => {
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const user = req.session.user;

  // 비로그인 시 전체 반환 (로그인 페이지 등 예외 처리용)
  if (!user) return res.json(data);

  const level = user.level || 4;
  const name = user.name;
  const team = user.team;
  const division = user.division;

  const filtered = data.projects.map(project => {
    const filteredTasks = project.tasks.map(task => {
      const assignees = task.assignees || [];

      // 단계 필터링
      const filteredSteps = (task.steps || []).filter(step => {
        const stepAssignees = step.assignees || [];
        if (level === 1) return true; // 대표이사/회장: 전체
        if (level === 2) return project.division === division || stepAssignees.length === 0 || stepAssignees.includes(name); // 이사: 부서 전체
        if (level === 3) return project.team === team || stepAssignees.length === 0 || stepAssignees.includes(name); // 팀장: 팀 전체
        return stepAssignees.length === 0 || stepAssignees.includes(name); // 팀원: 본인만
      });

      return { ...task, steps: filteredSteps };
    }).filter(task => {
      const assignees = task.assignees || [];
      if (level === 1) return true;
      if (level === 2) return project.division === division || assignees.length === 0 || assignees.includes(name);
      if (level === 3) return project.team === team || assignees.length === 0 || assignees.includes(name);
      return assignees.length === 0 || assignees.includes(name);
    });

    return { ...project, tasks: filteredTasks };
  }).filter(project => project.tasks.length > 0);

  res.json({ projects: filtered });
});

// ─── 프로젝트 수정 API ──────────────────────────────────

function saveProjects(data) {
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  // GitHub 자동 커밋 (비동기, 실패해도 서버 동작에 영향 없음)
  if (process.env.GITHUB_TOKEN) {
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
    fetch('https://api.github.com/repos/galaxyboys318/sungwoo-report-system/contents/data/projects.json', {
      method: 'GET',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    })
    .then(r => r.json())
    .then(fileInfo => {
      return fetch('https://api.github.com/repos/galaxyboys318/sungwoo-report-system/contents/data/projects.json', {
        method: 'PUT',
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: '[자동] projects.json 업데이트',
          content: content,
          sha: fileInfo.sha,
        })
      });
    })
    .then(() => console.log('[GitHub] projects.json 자동 커밋 완료'))
    .catch(e => console.error('[GitHub] 커밋 실패:', e.message));
  }
}

// 관리자용 전체 프로젝트 조회 (필터링 없음)
app.get('/api/projects/all', requireAdmin, (req, res) => {
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  res.json(data);
});

// 단위업무 담당자 수정
app.post('/api/projects/task/assignees', (req, res) => {
  const { projectId, taskId, assignees } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  const task = project?.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: '단위업무 없음' });
  task.assignees = assignees || [];
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 단계 담당자 수정
app.post('/api/projects/step/assignees', (req, res) => {
  const { projectId, taskId, stepId, assignees } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  const task = project?.tasks.find(t => t.id === taskId);
  const step = task?.steps?.find(s => s.id === stepId);
  if (!step) return res.status(404).json({ error: '단계 없음' });
  step.assignees = assignees || [];
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 단위업무 추가 (assignees 배열로 변경)
app.post('/api/projects/task/add', (req, res) => {
  const { projectId, taskName, assignees } = req.body;
  if (!projectId || !taskName) return res.status(400).json({ error: '잘못된 요청' });

  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  const newId = `${projectId}t${Date.now()}`;
  project.tasks.push({ id: newId, name: taskName, assignees: assignees || [], steps: [] });
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 단위업무 삭제
app.post('/api/projects/task/delete', (req, res) => {
  const { projectId, taskId } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  project.tasks = project.tasks.filter(t => t.id !== taskId);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 프로젝트 정보 수정
app.post('/api/projects/update', (req, res) => {
  const { projectId, updates } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });
  Object.assign(project, updates);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 프로젝트 삭제
app.post('/api/projects/delete', (req, res) => {
  const { projectId } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  data.projects = data.projects.filter(p => p.id !== projectId);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 단계 추가
app.post('/api/projects/step/add', (req, res) => {
  const { projectId, taskId, stepName, stepType, target, assignees } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  const task = project?.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: '단위업무 없음' });
  if (!task.steps) task.steps = [];
  const newStep = { id: `s${Date.now()}`, name: stepName, type: stepType, assignees: assignees || [] };
  if (stepType === 'qty') { newStep.target = target; newStep.current = 0; }
  if (stepType === 'pct') newStep.pct = 0;
  if (stepType === 'check') newStep.done = false;
  task.steps.push(newStep);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 단계값 저장 (직원 폼에서 체크/수량/비율 입력 시)
app.post('/api/projects/step/update', (req, res) => {
  const { projectId, taskId, stepId, type, value, memo } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  const task = project?.tasks.find(t => t.id === taskId);
  const step = task?.steps?.find(s => s.id === stepId);
  if (!step) return res.status(404).json({ error: '단계 없음' });

  if (type === 'check') step.done = value;
  else if (type === 'qty') step.current = value;
  else if (type === 'pct') {
    if (!step.history) step.history = [];
    if (step.pct !== value) {
      step.history.push({ date: new Date().toISOString().slice(0, 10), from: step.pct || 0, to: value });
    }
    step.pct = value;
  }
  // 메모 저장 (type=memo 이거나 memo 필드가 있을 때)
  if (req.body.memo !== undefined) step.memo = req.body.memo;
  if (memo !== undefined) step.memo = memo;
  saveProjects(data);
  res.json({ success: true });
});

app.post('/api/projects/step/delete', (req, res) => {
  const { projectId, taskId, stepId } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  const task = project?.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: '단위업무 없음' });
  task.steps = (task.steps || []).filter(s => s.id !== stepId);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 프로젝트 추가
app.post('/api/projects/add', (req, res) => {
  const { name, tag, division, team, manager, assignee, startDate, targetDate } = req.body;
  if (!name || !tag) return res.status(400).json({ error: '잘못된 요청' });
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const newId = `p${Date.now()}`;
  data.projects.push({ id: newId, name, tag, division: division||'', team: team||'', manager: manager||'', assignee: assignee||'', startDate: startDate||'', targetDate: targetDate||'', tasks: [] });
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});
// ─── 라우트 ─────────────────────────────────────────────

// 로그인 페이지
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/report');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// 관리자 페이지
app.get('/admin', requireLogin, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// 입력 폼 페이지
app.get('/report', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'form.html'));
});

// 미리보기 HTML 페이지
app.get('/report/preview-page', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'preview.html'));
});

// GPT 변환 API (체크된 프로젝트/단위업무 → 보고서)
app.post('/report/preview', async (req, res) => {
  const { checkedTasks, extraMemo } = req.body;

  if (!checkedTasks || checkedTasks.length === 0) {
    return res.status(400).json({ error: '체크된 항목이 없습니다.' });
  }

  try {
    const reporterName = req.session.user?.name || process.env.REPORTER_NAME;
    const reporterTeam = req.session.user?.team || process.env.REPORTER_TEAM;
    const report = await convertToReport(
      checkedTasks,
      extraMemo || '',
      reporterName,
      reporterTeam
    );

    const htmlBody = buildHtmlEmail(report, reporterName, reporterTeam, checkedTasks);
    res.json({
      ...report,
      htmlBody,
      checkedTasks,
      reporterEmail: process.env.REPORTER_EMAIL,
      recipientManager: process.env.RECIPIENT_MANAGER,
      recipientExec: process.env.RECIPIENT_EXEC,
    });
  } catch (e) {
    console.error('[GPT 변환 오류]', e.message);
    res.status(500).json({ error: 'GPT 변환 중 오류가 발생했습니다.' });
  }
});

// 메일 발송 API
app.post('/report/send', async (req, res) => {
  const { report, recipients, checkedTasks } = req.body;

  if (!report || !recipients || recipients.length === 0) {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }

  // recipients는 이메일 주소 배열 또는 'manager'/'exec' 레거시 키 혼용 지원
  const usersData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const recipientMap = {
    manager: process.env.RECIPIENT_MANAGER,
    exec: process.env.RECIPIENT_EXEC,
  };
  const toAddresses = recipients.map(r => {
    // 이메일 형식이면 그대로 사용
    if (r.includes('@')) return r;
    // 레거시 키('manager', 'exec')면 env에서 가져오기
    return recipientMap[r] || null;
  }).filter(Boolean);

  if (toAddresses.length === 0) {
    return res.status(400).json({ error: '유효한 수신자가 없습니다.' });
  }

  try {
    const reporterName = req.session.user?.name || process.env.REPORTER_NAME;
    const reporterTeam = req.session.user?.team || process.env.REPORTER_TEAM;
    await sendReport(report, toAddresses, reporterName, reporterTeam, checkedTasks || report.checkedTasks);

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(__dirname, 'data', 'reports', `${today}.json`);
    const newEntry = {
      timestamp: new Date().toISOString(),
      reporterName: req.session.user?.name || '',
      subject: report.subject,
      body: report.body,
      sentTo: toAddresses,
    };
    // 기존 기록에 누적 저장 (배열)
    let logs = [];
    if (fs.existsSync(logPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        logs = Array.isArray(existing) ? existing : [existing];
      } catch (e) { logs = []; }
    }
    logs.push(newEntry);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf-8');

    res.json({ success: true, sentTo: toAddresses, date: report.date });
  } catch (e) {
    console.error('[메일 발송 오류]', e.message);
    res.status(500).json({ error: '메일 발송 중 오류: ' + e.message });
  }
});

// SMTP 테스트
app.get('/report/test-smtp', async (req, res) => {
  try {
    await verifyConnection();
    res.json({ ok: true, message: 'SMTP 연결 성공' });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'SMTP 연결 실패: ' + e.message });
  }
});

// ─── 대시보드 ────────────────────────────────────────────

// 대시보드 페이지
app.get('/dashboard', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// 오늘 보고자 목록 API
app.get('/api/reports/today', requireLogin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(__dirname, 'data', 'reports', `${today}.json`);
  try {
    if (!fs.existsSync(logPath)) return res.json({ reporters: [] });
    const logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    // 배열 형태로 저장된 경우 처리
    const entries = Array.isArray(logs) ? logs : [logs];
    const reporters = [...new Set(entries.map(e => e.reporterName).filter(Boolean))];
    res.json({ reporters });
  } catch (e) {
    res.json({ reporters: [] });
  }
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/report');
  res.redirect('/login');
});

app.listen(PORT, () => {
  console.log(`✅ 일일보고 서버 실행 중: http://localhost:${PORT}/report`);
  console.log(`   보고자: ${process.env.REPORTER_NAME} (${process.env.REPORTER_TEAM})`);
  console.log(`   수신자: ${process.env.RECIPIENT_MANAGER}, ${process.env.RECIPIENT_EXEC}`);
});

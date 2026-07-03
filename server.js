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
  if (req.session.user?.role === 'admin' || req.session.user?.isAdmin === true) return next();
  res.status(403).json({ error: '관리자 권한이 필요합니다.' });
}

// 시스템관리자 전용 (직원 관리, 권한 부여 등 민감한 작업)
function requireSystemAdmin(req, res, next) {
  const u = req.session.user;
  const isAdmin = u?.role === 'admin' || u?.isAdmin === true;
  const scope = u?.adminScope || 'system';
  if (isAdmin && scope === 'system') return next();
  res.status(403).json({ error: '시스템관리자 권한이 필요합니다.' });
}

// 관리자의 권한 범위 조회 헬퍼
function getAdminScope(user) {
  const scope = user?.adminScope || 'system';
  const teams = user?.managedTeams || [];
  return { scope, teams };
}

// 프로젝트가 관리자 권한 범위 내에 있는지 확인
function isProjectInScope(user, project) {
  const { scope, teams } = getAdminScope(user);
  if (scope === 'system') return true;
  return teams.includes(project.team);
}

function requireTeamLead(req, res, next) {
  const level = req.session.user?.level || 4;
  if (level <= 3) return next(); // 팀장 이상
  res.status(403).json({ error: '팀장 이상 권한이 필요합니다.' });
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
    isAdmin: user.isAdmin || false,
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
  if (process.env.GITHUB_TOKEN) {
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
    fetch('https://api.github.com/repos/galaxyboys318/sungwoo-report-system/contents/data/users.json', {
      method: 'GET',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    })
    .then(r => r.json())
    .then(fileInfo => fetch('https://api.github.com/repos/galaxyboys318/sungwoo-report-system/contents/data/users.json', {
      method: 'PUT',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '[자동] users.json 업데이트', content, sha: fileInfo.sha })
    }))
    .then(() => console.log('[GitHub] users.json 자동 커밋 완료'))
    .catch(e => console.error('[GitHub] users 커밋 실패:', e.message));
  }
}

app.get('/api/recipients', requireLogin, (req, res) => {
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const me = data.users.find(u => u.email === req.session.user.email);
  const myReportsTo = me?.reportsTo || [];

  const result = [];
  data.users.forEach(u => {
    if (u.id === me?.id) return;
    const { password, ...user } = u;
    // 경영진(level 1) 또는 직속 상급자(reportsTo) 모두 체크박스에 표시
    if (u.level === 1 || myReportsTo.includes(u.id)) {
      result.push({ ...user });
    }
  });
  // 경영진 먼저, 직속 상급자 그 다음 순서
  result.sort((a, b) => (a.level || 4) - (b.level || 4));
  res.json({ recipients: result });
});

// reportsTo 변경 API (관리자)
app.post('/api/users/reportsTo', requireSystemAdmin, (req, res) => {
  const { userId, reportsTo } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.reportsTo = Array.isArray(reportsTo) ? reportsTo : [];
  saveUsers(data);
  res.json({ success: true });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const { scope, teams } = getAdminScope(req.session.user);
  // 비밀번호 제외하고 응답, 권한 범위에 맞게 필터링
  let users = data.users.map(({ password, ...u }) => u);
  if (scope !== 'system') {
    users = users.filter(u => teams.includes(u.team) || u.id === req.session.user.id);
  }
  res.json({ users });
});

app.post('/api/users/add', requireSystemAdmin, (req, res) => {
  const { name, email, password, role, team, division, position, level } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: '필수값 누락' });
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  if (data.users.find(u => u.email === email)) return res.status(400).json({ error: '이미 존재하는 이메일' });
  data.users.push({ id: `u${Date.now()}`, name, email, password, role: role || '팀원', position: position || '팀원', level: level || 4, isAdmin: false, team: team || '', division: division || '' });
  saveUsers(data);
  res.json({ success: true });
});

app.post('/api/users/delete', requireSystemAdmin, (req, res) => {
  const { userId } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  data.users = data.users.filter(u => u.id !== userId);
  saveUsers(data);
  res.json({ success: true });
});

app.post('/api/users/level', requireSystemAdmin, (req, res) => {
  const { email, level } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  user.level = parseInt(level);
  // 레벨에 따라 role 자동 업데이트 (isAdmin은 별도 관리)
  const roleMap = { 1: '회장', 2: '이사', 3: '팀장', 4: '팀원' };
  user.role = roleMap[user.level] || '팀원';
  saveUsers(data);
  res.json({ success: true });
});

// 직급(position) 변경
app.post('/api/users/position', requireSystemAdmin, (req, res) => {
  const { userId, position } = req.body;
  if (!position) return res.status(400).json({ error: '직급을 입력해주세요.' });
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  user.position = position;
  saveUsers(data);
  res.json({ success: true });
});

// 팀/부서 변경
app.post('/api/users/team', requireSystemAdmin, (req, res) => {
  const { userId, team, division } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (team !== undefined) user.team = team;
  if (division !== undefined) user.division = division;
  saveUsers(data);
  res.json({ success: true });
});

app.post('/api/users/admin', requireSystemAdmin, (req, res) => {
  const { userId, isAdmin } = req.body;
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.isAdmin = isAdmin;
  // 관리자 해제 시 권한 범위도 초기화
  if (!isAdmin) {
    user.adminScope = 'system';
    user.managedTeams = [];
  } else if (!user.adminScope) {
    user.adminScope = 'system'; // 기본값 — 시스템관리자에서 운영관리자 범위 변경 API로 조정 가능
  }
  saveUsers(data);
  res.json({ success: true });
});

// 관리자 권한 범위(adminScope/managedTeams) 설정 — 시스템관리자만 변경 가능
app.post('/api/users/adminScope', requireSystemAdmin, (req, res) => {
  const { userId, adminScope, managedTeams } = req.body;
  if (!['system', 'division', 'team'].includes(adminScope)) {
    return res.status(400).json({ error: '잘못된 adminScope 값입니다.' });
  }
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  if (!user.isAdmin) return res.status(400).json({ error: '먼저 관리자 권한을 부여해야 합니다.' });
  user.adminScope = adminScope;
  user.managedTeams = adminScope === 'system' ? [] : (Array.isArray(managedTeams) ? managedTeams : []);
  saveUsers(data);
  res.json({ success: true });
});

// 본인 비밀번호 변경
app.post('/api/users/my-password', requireLogin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '필수값 누락' });
  if (newPassword.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const user = data.users.find(u => u.email === req.session.user.email);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  if (user.password !== currentPassword) return res.status(400).json({ error: '현재 비밀번호가 맞지 않습니다.' });
  user.password = newPassword;
  saveUsers(data);
  res.json({ success: true });
});

app.post('/api/users/password', requireSystemAdmin, (req, res) => {
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
        // 팀원: 본인 팀 프로젝트 내에서만 + (담당자 미지정 또는 본인 포함)
        return project.team === team && (stepAssignees.length === 0 || stepAssignees.includes(name));
      });

      return { ...task, steps: filteredSteps };
    }).filter(task => {
      const assignees = task.assignees || [];
      if (level === 1) return true;
      if (level === 2) return project.division === division || assignees.length === 0 || assignees.includes(name);
      if (level === 3) return project.team === team || assignees.length === 0 || assignees.includes(name);
      // 팀원: 본인 팀 프로젝트 내에서만 + (담당자 미지정 또는 본인 포함)
      return project.team === team && (assignees.length === 0 || assignees.includes(name));
    });

    return { ...project, tasks: filteredTasks };
  }).filter(project => project.tasks.length > 0);

  res.json({ projects: filtered });
});

// ─── 프로젝트 수정 API ──────────────────────────────────

// GitHub 범용 저장 헬퍼
async function saveToGitHub(ghPath, data) {
  if (!process.env.GITHUB_TOKEN) return;
  const REPO = 'galaxyboys318/sungwoo-report-system';
  const HEADERS = {
    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
  const ghContent = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, { headers: HEADERS });
  const fileInfo = getRes.ok ? await getRes.json() : {};
  await fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, {
    method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ message: `[자동] ${ghPath}`, content: ghContent, sha: fileInfo.sha }),
  });
}

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
  const { scope, teams } = getAdminScope(req.session.user);
  if (scope === 'system') return res.json(data);
  res.json({ projects: data.projects.filter(p => teams.includes(p.team)) });
});

// 단위업무 담당자 수정 (관리자)
app.post('/api/projects/task/assignees', requireAdmin, (req, res) => {
  const { projectId, taskId, assignees } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project || !isProjectInScope(req.session.user, project)) return res.status(403).json({ error: '권한 범위 밖의 프로젝트입니다.' });
  const task = project?.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: '단위업무 없음' });
  task.assignees = assignees || [];
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 단계 담당자 수정 (관리자)
app.post('/api/projects/step/assignees', requireAdmin, (req, res) => {
  const { projectId, taskId, stepId, assignees } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project || !isProjectInScope(req.session.user, project)) return res.status(403).json({ error: '권한 범위 밖의 프로젝트입니다.' });
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

// 단위업무 삭제 (관리자)
app.post('/api/projects/task/delete', requireAdmin, (req, res) => {
  const { projectId, taskId } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });
  if (!isProjectInScope(req.session.user, project)) return res.status(403).json({ error: '권한 범위 밖의 프로젝트입니다.' });

  project.tasks = project.tasks.filter(t => t.id !== taskId);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 프로젝트 정보 수정 (관리자)
app.post('/api/projects/update', requireAdmin, (req, res) => {
  const { projectId, updates } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });
  if (!isProjectInScope(req.session.user, project)) return res.status(403).json({ error: '권한 범위 밖의 프로젝트입니다.' });
  // 운영관리자는 프로젝트를 본인 권한 범위 밖 팀으로 옮길 수 없음
  const { scope, teams } = getAdminScope(req.session.user);
  if (scope !== 'system' && updates?.team && !teams.includes(updates.team)) {
    return res.status(403).json({ error: '권한 범위 밖의 팀으로 변경할 수 없습니다.' });
  }
  Object.assign(project, updates);
  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// 프로젝트 삭제 (관리자)
app.post('/api/projects/delete', requireAdmin, (req, res) => {
  const { projectId } = req.body;
  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });
  if (!isProjectInScope(req.session.user, project)) return res.status(403).json({ error: '권한 범위 밖의 프로젝트입니다.' });

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
  // 메모 저장 — 날짜별 누적 (memoHistory)
  if (memo !== undefined && memo.trim() !== '') {
    if (!step.memoHistory) step.memoHistory = [];
    const today = new Date().toISOString().slice(0, 10);
    const existing = step.memoHistory.find(m => m.date === today);
    if (existing) existing.memo = memo;
    else step.memoHistory.push({ date: today, memo });
    step.memo = memo; // 호환성 유지
  }
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
app.post('/api/projects/add', requireAdmin, (req, res) => {
  const { name, tag, division, team, manager, assignee, startDate, targetDate } = req.body;
  if (!name || !tag) return res.status(400).json({ error: '잘못된 요청' });

  const { scope, teams } = getAdminScope(req.session.user);
  if (scope !== 'system' && (!team || !teams.includes(team))) {
    return res.status(403).json({ error: '본인 관리 범위 내의 팀으로만 프로젝트를 생성할 수 있습니다.' });
  }

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
    if (r.includes('@')) return r;
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
      reporterEmail: req.session.user?.email || '',
      reporterName: req.session.user?.name || '',
      reporterTeam: req.session.user?.team || '',
      subject: report.subject,
      body: report.body,
      htmlBody: buildHtmlEmail(report, reporterName, reporterTeam, checkedTasks || report.checkedTasks),
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

    // GitHub 백업
    if (process.env.GITHUB_TOKEN) {
      const ghContent = Buffer.from(JSON.stringify(logs, null, 2), 'utf-8').toString('base64');
      const ghPath = `data/reports/${today}.json`;
      fetch(`https://api.github.com/repos/galaxyboys318/sungwoo-report-system/contents/${ghPath}`, {
        method: 'GET',
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
      })
      .then(r => r.json())
      .then(fileInfo => fetch(`https://api.github.com/repos/galaxyboys318/sungwoo-report-system/contents/${ghPath}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `[자동] ${today} 보고 기록`, content: ghContent, sha: fileInfo.sha || undefined })
      }))
      .then(() => console.log('[GitHub] 보고 기록 자동 커밋 완료'))
      .catch(e => console.error('[GitHub] 보고 기록 커밋 실패:', e.message));
    }

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

// 내 보고 내역 페이지
app.get('/my-reports', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'my-reports.html'));
});

// 내 보고 내역 목록 API (최근 30일)
app.get('/api/my-reports', requireLogin, (req, res) => {
  const myEmail = req.session.user?.email;
  const reportsDir = path.join(__dirname, 'data', 'reports');
  const result = [];
  try {
    const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 30);
    files.forEach(f => {
      const logs = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf-8'));
      const entries = Array.isArray(logs) ? logs : [logs];
      entries.forEach((e, idx) => {
        if (e.reporterEmail === myEmail || e.reporterName === req.session.user?.name) {
          result.push({
            id: `${f.replace('.json','')}_${idx}`,
            date: f.replace('.json', ''),
            timestamp: e.timestamp,
            subject: e.subject,
            sentTo: e.sentTo,
          });
        }
      });
    });
    result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ reports: result });
  } catch (e) {
    res.json({ reports: [] });
  }
});

// 특정 보고서 상세(HTML) 조회
app.get('/api/my-reports/:id', requireLogin, (req, res) => {
  const { id } = req.params;
  const lastUnderscoreIdx = id.lastIndexOf('_');
  const date = id.slice(0, lastUnderscoreIdx);
  const idx = parseInt(id.slice(lastUnderscoreIdx + 1));
  const logPath = path.join(__dirname, 'data', 'reports', `${date}.json`);
  try {
    const logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    const entries = Array.isArray(logs) ? logs : [logs];
    const entry = entries[idx];
    if (!entry) return res.status(404).json({ error: '찾을 수 없습니다.' });
    // 본인 것만 조회 가능
    if (entry.reporterEmail !== req.session.user?.email && entry.reporterName !== req.session.user?.name) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }
    res.json(entry);
  } catch (e) {
    res.status(404).json({ error: '찾을 수 없습니다.' });
  }
});

// 일일보고 삭제
app.delete('/api/my-reports/:id', requireLogin, (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  const lastUnderscoreIdx = id.lastIndexOf('_');
  const date = id.slice(0, lastUnderscoreIdx);
  const idx = parseInt(id.slice(lastUnderscoreIdx + 1));

  if (isNaN(idx) || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return res.status(400).json({ error: '잘못된 요청' });
  }

  const logPath = path.join(__dirname, 'data', 'reports', `${date}.json`);
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: '파일 없음' });

  const logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  const entries = Array.isArray(logs) ? logs : [logs];
  const entry = entries[idx];

  if (!entry) return res.status(404).json({ error: '보고서 없음' });
  if (entry.reporterEmail !== user.email && entry.reporterName !== user.name) {
    return res.status(403).json({ error: '권한 없음' });
  }

  // 해당 entry 제거
  entries.splice(idx, 1);

  const ghPath = `data/reports/${date}.json`;
  if (entries.length === 0) {
    // 파일에 내 것만 있었으면 파일 삭제
    fs.unlinkSync(logPath);
    if (process.env.GITHUB_TOKEN) {
      const REPO = 'galaxyboys318/sungwoo-report-system';
      const HEADERS = { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' };
      fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, { headers: HEADERS })
        .then(r => r.ok ? r.json() : null)
        .then(info => {
          if (info?.sha) {
            fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, {
              method: 'DELETE', headers: { ...HEADERS, 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: `[삭제] ${ghPath}`, sha: info.sha }),
            });
          }
        }).catch(e => console.error('[GitHub 일일보고 삭제 실패]', e.message));
    }
  } else {
    // 다른 사람 것도 있으면 파일 유지, 해당 entry만 제거 후 저장
    fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf-8');
    saveToGitHub(ghPath, entries).catch(e => console.error('[GitHub 일일보고 업데이트 실패]', e.message));
  }

  res.json({ success: true });
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/report');
  res.redirect('/login');
});

// ─── 서버 시작 시 GitHub에서 최신 데이터 복원 ──────────────
async function pullDataFromGitHub() {
  if (!process.env.GITHUB_TOKEN) {
    console.log('[GitHub] GITHUB_TOKEN 없음 — 데이터 복원 건너뜀');
    return;
  }

  const REPO = 'galaxyboys318/sungwoo-report-system';
  const HEADERS = {
    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
  };

  async function fetchAndSave(ghPath, localPath) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, { headers: HEADERS });
      if (!res.ok) return;
      const fileInfo = await res.json();
      const content = Buffer.from(fileInfo.content, 'base64').toString('utf-8');
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, content, 'utf-8');
      console.log(`[GitHub] 복원 완료: ${ghPath}`);
    } catch (e) {
      console.error(`[GitHub] 복원 실패: ${ghPath}`, e.message);
    }
  }

  // projects.json 복원
  await fetchAndSave('data/projects.json', PROJECTS_PATH);

  // users.json 복원 — 비밀번호는 GitHub 값 무시, 로컬 값 우선
  // 로컬 파일이 이미 있으면 GitHub에서 구조(adminScope 등)만 업데이트하고 비밀번호는 반드시 보존
  // 로컬 파일이 없으면(최초 배포) GitHub에서 복원하되 비밀번호는 기본값 유지
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/data/users.json`, { headers: HEADERS });
    if (res.ok) {
      const fileInfo = await res.json();
      const ghData = JSON.parse(Buffer.from(fileInfo.content, 'base64').toString('utf-8'));

      if (fs.existsSync(USERS_PATH)) {
        // 로컬 파일이 있으면: 비밀번호와 현재 세션 데이터를 로컬에서 가져와 덮어쓰기
        const localData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
        const localMap = {};
        (localData.users || []).forEach(u => { localMap[u.id] = u; });

        (ghData.users || []).forEach(u => {
          if (localMap[u.id]) {
            // 비밀번호는 무조건 로컬값 사용
            u.password = localMap[u.id].password || u.password;
          }
        });
        fs.writeFileSync(USERS_PATH, JSON.stringify(ghData, null, 2), 'utf-8');
        console.log('[GitHub] 복원 완료: data/users.json (비밀번호 로컬값 보존)');
      } else {
        // 로컬 파일 없음(최초 배포): 그냥 GitHub 값 사용
        fs.writeFileSync(USERS_PATH, JSON.stringify(ghData, null, 2), 'utf-8');
        console.log('[GitHub] 복원 완료: data/users.json (최초 배포)');
      }
    }
  } catch (e) {
    console.error('[GitHub] users.json 복원 실패:', e.message);
  }

  // data/reports/ 폴더 내 모든 파일 복원
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/data/reports`, { headers: HEADERS });
    if (res.ok) {
      const files = await res.json();
      const reportsDir = path.join(__dirname, 'data', 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      await Promise.all(
        files.filter(f => f.name.endsWith('.json')).map(f =>
          fetchAndSave(`data/reports/${f.name}`, path.join(reportsDir, f.name))
        )
      );
    }
  } catch (e) {
    console.error('[GitHub] reports 폴더 복원 실패:', e.message);
  }
}

pullDataFromGitHub().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 일일보고 서버 실행 중: http://localhost:${PORT}/report`);
  });
});

// ─── 주간보고 ───────────────────────────────────────────────
app.get('/weekly', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'weekly.html'));
});

// 이번 주 월~오늘 날짜 범위 계산 헬퍼
function getWeekRange() {
  const today = new Date();
  const day = today.getDay(); // 0=일, 1=월
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const dates = [];
  for (let d = new Date(monday); d <= today; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return { dates, weekStart: monday.toISOString().slice(0, 10), weekEnd: today.toISOString().slice(0, 10) };
}

// 주간 데이터 조회 API
app.get('/api/weekly-data', requireLogin, (req, res) => {
  const user = req.session.user;
  const reportsDir = path.join(__dirname, 'data', 'reports');
  const { dates, weekStart, weekEnd } = getWeekRange();

  const weeklyDays = [];
  dates.forEach(date => {
    const filePath = path.join(reportsDir, `${date}.json`);
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const entries = Array.isArray(raw) ? raw : [raw];
      const mine = entries.filter(e =>
        e.reporterEmail === user.email || e.reporterName === user.name
      );
      if (mine.length > 0) weeklyDays.push({ date, entries: mine });
    } catch (e) {}
  });

  res.json({ weeklyDays, weekStart, weekEnd, user });
});

// 주간보고 발송 API
app.post('/api/weekly-send', requireLogin, async (req, res) => {
  const { weekStart, weekEnd, weeklyDays, aiSummary, recipients } = req.body;
  const user = req.session.user;

  // 클라이언트에서 선택한 수신자 사용, 없으면 reportsTo 기반 자동
  const usersData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  let toAddresses;
  if (recipients && recipients.length > 0) {
    const validEmails = usersData.users.map(u => u.email);
    toAddresses = recipients.filter(e => validEmails.includes(e));
  } else {
    const me = usersData.users.find(u => u.email === user.email);
    const myReportsTo = me?.reportsTo || [];
    const reportsToEmails = usersData.users
      .filter(u => myReportsTo.includes(u.id) || u.level === 1)
      .filter(u => u.email !== user.email)
      .map(u => u.email);
    toAddresses = reportsToEmails;
  }

  if (toAddresses.length === 0) return res.status(400).json({ error: '수신자 없음' });

  try {
    const { sendWeeklyReport } = require('./mailer');
    await sendWeeklyReport({ weekStart, weekEnd, weeklyDays, aiSummary }, toAddresses, user.name, user.team);

    // 주간보고 data/weekly/에 저장 + GitHub 백업
    const weeklyDir = path.join(__dirname, 'data', 'weekly');
    if (!fs.existsSync(weeklyDir)) fs.mkdirSync(weeklyDir, { recursive: true });

    // ISO 주차 계산
    function getISOWeek(d) {
      const date = new Date(d); date.setHours(0,0,0,0);
      date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
      const week1 = new Date(date.getFullYear(), 0, 4);
      return 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    }
    function getISOYear(d) {
      const date = new Date(d); date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
      return date.getFullYear();
    }

    const wDate = new Date(weekEnd);
    const isoYear = getISOYear(wDate);
    const isoWeek = getISOWeek(wDate);
    const weekKey = `${isoYear}-W${String(isoWeek).padStart(2,'0')}`;

    // 프로젝트별 진행률 스냅샷 (가중치 포함)
    const projData2 = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
    const projectSnapshot = {};
    (projData2.projects || []).forEach(p => {
      const tasks = {};
      (p.tasks || []).forEach(t => {
        const steps = t.steps || [];
        let progress = 0;
        if (steps.length > 0) {
          const total = steps.reduce((sum, s) => {
            if (s.type === 'check') return sum + (s.done ? 100 : 0);
            if (s.type === 'qty') return sum + (s.target > 0 ? Math.min(100, Math.round((s.current||0)/s.target*100)) : 0);
            if (s.type === 'pct') return sum + (s.pct || 0);
            return sum;
          }, 0);
          progress = Math.round(total / steps.length);
        }
        tasks[t.name] = { id: t.id, progress, weight: t.weight || 0, stepsDone: steps.filter(s => s.done || (s.pct||0) >= 100 || ((s.current||0) >= (s.target||1))).length, totalSteps: steps.length };
      });
      projectSnapshot[p.name] = { id: p.id, tag: p.tag || '', tasks };
    });

    // 전주 스냅샷 찾기 (비교용)
    const prevWeekNum = isoWeek === 1 ? 52 : isoWeek - 1;
    const prevYear = isoWeek === 1 ? isoYear - 1 : isoYear;
    const prevWeekKey = `${prevYear}-W${String(prevWeekNum).padStart(2,'0')}`;
    let prevSnapshot = null;
    const weeklyDir2 = path.join(__dirname, 'data', 'weekly');
    if (fs.existsSync(weeklyDir2)) {
      const prevFile = fs.readdirSync(weeklyDir2).find(f => f.startsWith(prevWeekKey) && (f.includes(user.id) || f.includes(user.email)));
      if (prevFile) {
        try {
          const prev = JSON.parse(fs.readFileSync(path.join(weeklyDir2, prevFile), 'utf-8'));
          prevSnapshot = prev.projectSnapshot || null;
        } catch(e) {}
      }
    }

    const weeklyRecord = {
      weekKey, weekStart, weekEnd, isoYear, isoWeek,
      reporter: user.name, team: user.team, email: user.email,
      sentAt: new Date().toISOString(),
      sentTo: toAddresses,
      aiSummary,
      weeklyDays,
      projectSnapshot,
      prevSnapshot,
    };

    const weeklyFilePath = path.join(weeklyDir, `${weekKey}-${user.id || user.email}.json`);
    fs.writeFileSync(weeklyFilePath, JSON.stringify(weeklyRecord, null, 2), 'utf-8');

    // GitHub 백업
    const ghWeeklyPath = `data/weekly/${weekKey}-${user.id || user.email}.json`;
    saveToGitHub(ghWeeklyPath, weeklyRecord).catch(e => console.error('[GitHub weekly 백업 실패]', e.message));

    // 주간보고 발송 후 memoHistory 초기화
    const projData = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
    projData.projects.forEach(p => {
      (p.tasks || []).forEach(t => {
        (t.steps || []).forEach(s => {
          s.memoHistory = [];
          s.memo = '';
        });
      });
    });
    saveProjects(projData);

    res.json({ success: true });
  } catch (e) {
    console.error('주간보고 발송 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 내 주간보고 목록 조회
app.get('/api/weekly-list', requireLogin, (req, res) => {
  const user = req.session.user;
  const weeklyDir = path.join(__dirname, 'data', 'weekly');
  const records = [];
  if (fs.existsSync(weeklyDir)) {
    fs.readdirSync(weeklyDir).forEach(f => {
      if (!f.endsWith('.json')) return;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(weeklyDir, f), 'utf-8'));
        if (rec.email !== user.email && rec.reporter !== user.name) return;
        records.push({ fileName: f, weekKey: rec.weekKey, weekStart: rec.weekStart, weekEnd: rec.weekEnd, sentAt: rec.sentAt, sentTo: rec.sentTo, aiSummary: rec.aiSummary });
      } catch (e) {}
    });
  }
  records.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  res.json({ records });
});

// 주간보고 삭제 (분기집계에서 제외)
app.delete('/api/weekly-delete/:fileName', requireLogin, (req, res) => {
  const user = req.session.user;
  const fileName = req.params.fileName;
  // 파일명 검증 (경로 탐색 방지)
  if (!fileName.endsWith('.json') || fileName.includes('/') || fileName.includes('..')) {
    return res.status(400).json({ error: '잘못된 파일명' });
  }
  const filePath = path.join(__dirname, 'data', 'weekly', fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음' });

  // 본인 파일인지 확인
  const rec = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (rec.email !== user.email && rec.reporter !== user.name) {
    return res.status(403).json({ error: '권한 없음' });
  }

  fs.unlinkSync(filePath);

  // GitHub에서도 삭제
  if (process.env.GITHUB_TOKEN) {
    const REPO = 'galaxyboys318/sungwoo-report-system';
    const HEADERS = {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    };
    const ghPath = `data/weekly/${fileName}`;
    fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, { headers: HEADERS })
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        if (info?.sha) {
          return fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, {
            method: 'DELETE',
            headers: { ...HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `[삭제] ${ghPath}`, sha: info.sha }),
          });
        }
      })
      .catch(e => console.error('[GitHub 주간보고 삭제 실패]', e.message));
  }

  res.json({ success: true });
});

// GPT 주간 요약 API
app.post('/api/gpt-weekly', requireLogin, async (req, res) => {
  const { weekStart, weekEnd, bodies, stepSummary, user } = req.body;
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 회사 업무보고 작성 전문가입니다. 아래 규칙을 반드시 지켜 주간 업무 요약을 작성해주세요.

[필수 규칙]
- 실제 보고 내용에 명시된 것만 작성. 없는 내용, 추측, 미래 계획 절대 작성 금지
- 수량/비율은 보고 내용 그대로만 표기 (예: 2/5개 → "2/5개 진행")
- "완료", "성공" 등의 표현은 실제로 완료된 경우에만 사용
- 차주 계획은 보고 내용에 명시된 경우에만 작성, 없으면 생략
- 항목별로 간결하게 나열 (한 항목 1~2줄)
- 경어체, 과장 표현 금지`
        },
        {
          role: 'user',
          content: `${user.name} (${user.team}) 님의 ${weekStart} ~ ${weekEnd} 주간 업무 내역입니다.

[단계별 실제 진행 데이터 - 이 수치를 기준으로 작성]
${(stepSummary || []).join('\n') || '없음'}

[일일보고 원문]
${bodies}

위 데이터를 바탕으로 주간 업무 요약을 작성해주세요. 단계별 진행 데이터의 수치를 반드시 그대로 사용하세요.`
        }
      ],
      max_tokens: 600,
    });
    res.json({ summary: completion.choices[0].message.content });
  } catch (e) {
    console.error('[GPT 주간 요약 오류]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 분기보고 ─────────────────────────────────────────────
app.get('/quarterly', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'quarterly.html'));
});

// 분기 데이터 집계 API
app.get('/api/quarterly-data', requireLogin, (req, res) => {
  const user = req.session.user;
  const { year, quarter } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const q = parseInt(quarter) || Math.ceil((new Date().getMonth() + 1) / 3);

  // 해당 분기 주차 범위
  const qStartMonth = (q - 1) * 3;
  const qStart = new Date(y, qStartMonth, 1);
  const qEnd = new Date(y, qStartMonth + 3, 0);

  // data/weekly/ 에서 해당 분기 파일 읽기
  const weeklyDir = path.join(__dirname, 'data', 'weekly');
  const weeklyRecords = [];
  if (fs.existsSync(weeklyDir)) {
    fs.readdirSync(weeklyDir).forEach(f => {
      if (!f.endsWith('.json')) return;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(weeklyDir, f), 'utf-8'));
        if (rec.reporter !== user.name && rec.email !== user.email) return;
        const wEnd = new Date(rec.weekEnd);
        if (wEnd >= qStart && wEnd <= qEnd) weeklyRecords.push(rec);
      } catch (e) {}
    });
  }
  weeklyRecords.sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  // 프로젝트별 주간 진행률 추이
  const projectTrend = {};
  weeklyRecords.forEach(rec => {
    Object.entries(rec.projectSnapshot || {}).forEach(([pName, pData]) => {
      if (!projectTrend[pName]) projectTrend[pName] = { tag: pData.tag, weeks: [] };
      const tasks = Object.values(pData.tasks || {});
      const totalWeight = tasks.reduce((s, t) => s + (t.weight || 0), 0);
      let avgProgress;
      if (totalWeight > 0) {
        avgProgress = tasks.reduce((s, t) => s + (t.progress || 0) * (t.weight || 0), 0) / totalWeight;
      } else {
        avgProgress = tasks.reduce((s, t) => s + (t.progress || 0), 0) / Math.max(tasks.length, 1);
      }
      projectTrend[pName].weeks.push({ weekKey: rec.weekKey, progress: Math.round(avgProgress) });
    });
  });

  res.json({ year: y, quarter: q, weeklyRecords, projectTrend, user });
});

// 분기보고 GPT 요약
app.post('/api/gpt-quarterly', requireLogin, async (req, res) => {
  const { year, quarter, weeklyRecords, user } = req.body;
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const summaries = (weeklyRecords || []).map(r => `[${r.weekKey}] ${r.aiSummary || ''}`).join('\n');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `분기 업무보고 요약 전문가입니다. 주간보고 요약들을 바탕으로 분기 성과를 간결하게 정리해주세요.
- 실제 내용에 있는 것만 작성, 없는 내용 추측 금지
- 주요 성과 3~5개 항목별 정리
- 수치는 그대로 사용
- 경어체, 과장 금지` },
        { role: 'user', content: `${user.name} (${user.team}) ${year}년 ${quarter}분기 주간보고 요약:\n\n${summaries}\n\n분기 업무 요약을 작성해주세요.` }
      ],
      max_tokens: 600,
    });
    res.json({ summary: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 분기보고 발송
app.post('/api/quarterly-send', requireLogin, async (req, res) => {
  const { year, quarter, weeklyRecords, projectTrend, aiSummary } = req.body;
  const user = req.session.user;
  const usersData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const toAddresses = usersData.users.filter(u => u.level <= 2 && u.email !== user.email).map(u => u.email);
  if (toAddresses.length === 0) return res.status(400).json({ error: '수신자 없음' });

  try {
    const { sendQuarterlyReport } = require('./mailer');
    await sendQuarterlyReport({ year, quarter, weeklyRecords, projectTrend, aiSummary }, toAddresses, user.name, user.team);

    // 저장
    const qDir = path.join(__dirname, 'data', 'quarterly');
    if (!fs.existsSync(qDir)) fs.mkdirSync(qDir, { recursive: true });
    const qKey = `${year}-Q${quarter}`;
    const qRecord = { qKey, year, quarter, reporter: user.name, team: user.team, email: user.email, sentAt: new Date().toISOString(), sentTo: toAddresses, aiSummary, weeklyRecords, projectTrend };
    fs.writeFileSync(path.join(qDir, `${qKey}-${user.id || user.email}.json`), JSON.stringify(qRecord, null, 2), 'utf-8');
    saveToGitHub(`data/quarterly/${qKey}-${user.id || user.email}.json`, qRecord).catch(e => console.error('[GitHub quarterly 백업 실패]', e.message));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 연말보고 ─────────────────────────────────────────────
app.get('/annual', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'annual.html'));
});

app.get('/api/annual-data', requireLogin, (req, res) => {
  const user = req.session.user;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const qDir = path.join(__dirname, 'data', 'quarterly');
  const quarterlyRecords = [];
  if (fs.existsSync(qDir)) {
    fs.readdirSync(qDir).forEach(f => {
      if (!f.endsWith('.json')) return;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(qDir, f), 'utf-8'));
        if ((rec.reporter !== user.name && rec.email !== user.email) || rec.year !== year) return;
        quarterlyRecords.push(rec);
      } catch (e) {}
    });
  }
  quarterlyRecords.sort((a, b) => a.quarter - b.quarter);
  res.json({ year, quarterlyRecords, user });
});

app.post('/api/gpt-annual', requireLogin, async (req, res) => {
  const { year, quarterlyRecords, user } = req.body;
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const summaries = (quarterlyRecords || []).map(r => `[${r.year}년 ${r.quarter}분기] ${r.aiSummary || ''}`).join('\n\n');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `연간 업무보고 요약 전문가입니다. 분기별 보고를 바탕으로 연간 성과를 간결하게 정리해주세요.
- 실제 내용에 있는 것만 작성, 없는 내용 추측 금지
- 분기별 주요 성과 요약 후 연간 총평
- 수치 그대로 사용, 경어체, 과장 금지` },
        { role: 'user', content: `${user.name} (${user.team}) ${year}년 분기별 보고 요약:\n\n${summaries}\n\n연간 업무 요약을 작성해주세요.` }
      ],
      max_tokens: 800,
    });
    res.json({ summary: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/annual-send', requireLogin, async (req, res) => {
  const { year, quarterlyRecords, aiSummary } = req.body;
  const user = req.session.user;
  const usersData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const toAddresses = usersData.users.filter(u => u.level <= 2 && u.email !== user.email).map(u => u.email);
  if (toAddresses.length === 0) return res.status(400).json({ error: '수신자 없음' });

  try {
    const { sendAnnualReport } = require('./mailer');
    await sendAnnualReport({ year, quarterlyRecords, aiSummary }, toAddresses, user.name, user.team);

    const aDir = path.join(__dirname, 'data', 'annual');
    if (!fs.existsSync(aDir)) fs.mkdirSync(aDir, { recursive: true });
    const aRecord = { year, reporter: user.name, team: user.team, email: user.email, sentAt: new Date().toISOString(), sentTo: toAddresses, aiSummary, quarterlyRecords };
    fs.writeFileSync(path.join(aDir, `${year}-${user.id || user.email}.json`), JSON.stringify(aRecord, null, 2), 'utf-8');
    saveToGitHub(`data/annual/${year}-${user.id || user.email}.json`, aRecord).catch(e => console.error('[GitHub annual 백업 실패]', e.message));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 팀 일일 취합보고 ───────────────────────────────────────
app.get('/team-daily', requireTeamLead, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'team-daily.html'));
});

app.get('/api/team-daily-status', requireTeamLead, (req, res) => {
  const leader = req.session.user;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const usersData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const teamMembers = usersData.users.filter(u => u.team === leader.team && u.email !== leader.email);

  const logPath = path.join(__dirname, 'data', 'reports', `${date}.json`);
  let entries = [];
  if (fs.existsSync(logPath)) {
    const raw = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    entries = Array.isArray(raw) ? raw : [raw];
  }

  const submitted = [];
  const missing = [];
  teamMembers.forEach(member => {
    const entry = entries.find(e => e.reporterEmail === member.email || e.reporterName === member.name);
    if (entry) {
      submitted.push({ email: member.email, reporterName: member.name, body: entry.body, subject: entry.subject, timestamp: entry.timestamp });
    } else {
      missing.push({ email: member.email, name: member.name });
    }
  });

  res.json({ date, team: leader.team, submitted, missing, totalMembers: teamMembers.length });
});

app.post('/api/team-daily-remind', requireTeamLead, async (req, res) => {
  const { email, name } = req.body;
  const leader = req.session.user;
  try {
    const { sendReminderEmail } = require('./mailer');
    await sendReminderEmail(email, name, leader.name, 'daily');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/team-daily-send', requireTeamLead, async (req, res) => {
  const { date, members, recipients } = req.body;
  const leader = req.session.user;

  if (!members || members.length === 0) return res.status(400).json({ error: '취합할 보고 내용이 없습니다.' });
  if (!recipients || recipients.length === 0) return res.status(400).json({ error: '수신자를 선택해주세요.' });

  try {
    const { sendTeamDailyReport } = require('./mailer');
    await sendTeamDailyReport(leader.team, date, members, leader.name, recipients);

    // 저장
    const dir = path.join(__dirname, 'data', 'team-reports', 'daily');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const record = { team: leader.team, date, leader: leader.name, sentAt: new Date().toISOString(), sentTo: recipients, members };
    const fileName = `${date}-${leader.team}.json`;
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(record, null, 2), 'utf-8');
    saveToGitHub(`data/team-reports/daily/${fileName}`, record).catch(e => console.error('[GitHub 팀일일취합 백업 실패]', e.message));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 팀 주간 취합보고 ───────────────────────────────────────
app.get('/team-weekly', requireTeamLead, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'team-weekly.html'));
});

function getISOWeekInfo(d) {
  const date = new Date(d); date.setHours(0,0,0,0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  const week = 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return { year: date.getFullYear(), week };
}

app.get('/api/team-weekly-status', requireTeamLead, (req, res) => {
  const leader = req.session.user;
  const today = new Date();
  const { year, week } = getISOWeekInfo(today);
  const weekKey = req.query.weekKey || `${year}-W${String(week).padStart(2,'0')}`;

  const usersData = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  const teamMembers = usersData.users.filter(u => u.team === leader.team && u.email !== leader.email);

  const weeklyDir = path.join(__dirname, 'data', 'weekly');
  const records = [];
  if (fs.existsSync(weeklyDir)) {
    fs.readdirSync(weeklyDir).forEach(f => {
      if (!f.endsWith('.json')) return;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(weeklyDir, f), 'utf-8'));
        if (rec.weekKey === weekKey && rec.team === leader.team) records.push(rec);
      } catch (e) {}
    });
  }

  const submitted = [];
  const missing = [];
  teamMembers.forEach(member => {
    const rec = records.find(r => r.email === member.email || r.reporter === member.name);
    if (rec) {
      submitted.push({ email: member.email, reporter: member.name, aiSummary: rec.aiSummary, weekStart: rec.weekStart, weekEnd: rec.weekEnd });
    } else {
      missing.push({ email: member.email, name: member.name });
    }
  });

  let weekStart = '', weekEnd = '';
  if (records.length > 0) { weekStart = records[0].weekStart; weekEnd = records[0].weekEnd; }

  res.json({ weekKey, team: leader.team, submitted, missing, totalMembers: teamMembers.length, weekStart, weekEnd });
});

app.post('/api/team-weekly-remind', requireTeamLead, async (req, res) => {
  const { email, name } = req.body;
  const leader = req.session.user;
  try {
    const { sendReminderEmail } = require('./mailer');
    await sendReminderEmail(email, name, leader.name, 'weekly');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/team-weekly-send', requireTeamLead, async (req, res) => {
  const { weekKey, weekStart, weekEnd, members, recipients } = req.body;
  const leader = req.session.user;

  if (!members || members.length === 0) return res.status(400).json({ error: '취합할 보고 내용이 없습니다.' });
  if (!recipients || recipients.length === 0) return res.status(400).json({ error: '수신자를 선택해주세요.' });

  try {
    const { sendTeamWeeklyReport } = require('./mailer');
    await sendTeamWeeklyReport(leader.team, weekKey, weekStart, weekEnd, members, leader.name, recipients);

    const dir = path.join(__dirname, 'data', 'team-reports', 'weekly');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const record = { team: leader.team, weekKey, weekStart, weekEnd, leader: leader.name, sentAt: new Date().toISOString(), sentTo: recipients, members };
    const fileName = `${weekKey}-${leader.team}.json`;
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(record, null, 2), 'utf-8');
    saveToGitHub(`data/team-reports/weekly/${fileName}`, record).catch(e => console.error('[GitHub 팀주간취합 백업 실패]', e.message));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 단위업무 가중치(%) 일괄 업데이트
app.post('/api/projects/task/weights', requireAdmin, (req, res) => {
  const { projectId, weights } = req.body; // weights: [{taskId, weight}]
  if (!projectId || !weights) return res.status(400).json({ error: '잘못된 요청' });

  const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = data.projects.find(p => p.id === projectId);
  if (!project || !isProjectInScope(req.session.user, project)) {
    return res.status(403).json({ error: '권한 없음' });
  }

  // 합계 100% 검증
  const total = weights.reduce((s, w) => s + (parseFloat(w.weight) || 0), 0);
  if (Math.abs(total - 100) > 0.1) {
    return res.status(400).json({ error: `가중치 합계가 100%여야 합니다. (현재 ${total.toFixed(1)}%)` });
  }

  weights.forEach(({ taskId, weight }) => {
    const task = project.tasks.find(t => t.id === taskId);
    if (task) task.weight = parseFloat(weight) || 0;
  });

  saveProjects(data);
  res.json({ success: true, projects: data.projects });
});

// ─── 프로젝트 취합 보고 ─────────────────────────────────────
app.get('/project-report', requireTeamLead, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'project-report.html'));
});

// 프로젝트 취합 데이터 조회
app.get('/api/project-report-data', requireTeamLead, (req, res) => {
  const { projectId, date } = req.query;
  const user = req.session.user;
  const today = date || new Date().toISOString().slice(0, 10);

  const projData = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = (projData.projects || []).find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  // 해당 날짜 보고 데이터에서 담당자별 체크 내역 수집
  const logPath = path.join(__dirname, 'data', 'reports', `${today}.json`);
  const reporterBodies = {};
  if (fs.existsSync(logPath)) {
    const logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    const entries = Array.isArray(logs) ? logs : [logs];
    entries.forEach(e => {
      if (e.reporterName) reporterBodies[e.reporterName] = e.body || '';
    });
  }

  // 단위업무별 담당자 + 진행 현황 + 오늘 메모 취합
  const tasks = (project.tasks || []).map(task => {
    const taskAssignees = task.assignees || [];
    const steps = (task.steps || []).map(step => {
      const stepAssignees = step.assignees || [];
      const allAssignees = [...new Set([...taskAssignees, ...stepAssignees])];

      // 오늘 날짜의 memoHistory 항목 수집
      const todayMemos = allAssignees
        .map(name => {
          const memoEntry = (step.memoHistory || []).find(m => m.date === today);
          return memoEntry ? { name, memo: memoEntry.memo } : null;
        })
        .filter(Boolean);

      return {
        id: step.id,
        name: step.name,
        type: step.type || 'check',
        done: step.done || false,
        pct: step.pct || 0,
        current: step.current || 0,
        target: step.target || 1,
        assignees: allAssignees,
        todayMemos,
        memo: step.memo || '',
      };
    });

    return {
      id: task.id,
      name: task.name,
      progress: task.progress || 0,
      assignees: taskAssignees,
      steps,
    };
  });

  res.json({ project: { id: project.id, name: project.name, tag: project.tag, team: project.team }, date: today, tasks });
});

// 프로젝트 취합 보고 발송
app.post('/api/project-report-send', requireTeamLead, async (req, res) => {
  const { projectId, date, tasks, recipients, summary } = req.body;
  const leader = req.session.user;

  if (!recipients || recipients.length === 0) return res.status(400).json({ error: '수신자를 선택해주세요.' });

  const projData = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  const project = (projData.projects || []).find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  try {
    const { sendProjectReport } = require('./mailer');
    await sendProjectReport({ project, date, tasks, summary }, leader.name, leader.team, recipients);

    // 저장
    const dir = path.join(__dirname, 'data', 'team-reports', 'project');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const record = { projectId, projectName: project.name, date, leader: leader.name, team: leader.team, sentAt: new Date().toISOString(), sentTo: recipients, tasks, summary };
    const fileName = `${date}-${projectId}.json`;
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(record, null, 2), 'utf-8');
    saveToGitHub(`data/team-reports/project/${fileName}`, record).catch(e => console.error('[GitHub 프로젝트취합 백업 실패]', e.message));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

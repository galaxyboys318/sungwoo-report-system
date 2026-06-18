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

function buildHtmlEmail(report, reporterName, reporterTeam) {
  const now = new Date();
  const days = ['일','월','화','수','목','금','토'];
  const dateStr = `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일 (${days[now.getDay()]})`;

  // 본문 텍스트를 HTML 줄바꿈으로 변환
  const bodyHtml = report.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map(line => {
      // 들여쓰기 보존
      const indent = line.match(/^(\s+)/);
      const paddingLeft = indent ? indent[1].length * 8 : 0;
      return `<div style="padding-left:${paddingLeft}px;min-height:1.6em">${line.trim() || '&nbsp;'}</div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f5f6fa;font-family:'Malgun Gothic','맑은 고딕',sans-serif;">

<!-- 헤더 -->
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1a73e8;">
  <tr>
    <td style="padding:16px 32px;">
      <span style="color:#fff;font-size:18px;font-weight:700;">⚙️ 도서출판 성우 · 일일업무보고</span>
    </td>
  </tr>
</table>

<!-- 본문 컨테이너 -->
<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td style="padding:28px 16px;">
      <table width="640" align="center" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

        <!-- 제목/날짜 -->
        <tr>
          <td style="padding-bottom:24px;">
            <div style="font-size:26px;font-weight:700;color:#1a1a2e;margin-bottom:6px;">일일 업무 보고서</div>
            <div style="font-size:15px;color:#888;">${dateStr} &nbsp;·&nbsp; 도서출판 성우 · ${reporterTeam || '솔루션개발팀'}</div>
          </td>
        </tr>

        <!-- 요약 카드 4개 -->
        <tr>
          <td style="padding-bottom:28px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="25%" style="padding-right:8px;">
                  <div style="background:#f0f4ff;border-radius:10px;padding:20px 12px;text-align:center;">
                    <div style="font-size:13px;color:#666;margin-bottom:8px;">보고자</div>
                    <div style="font-size:22px;font-weight:700;color:#1a1a2e;">${reporterName || '-'}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">${reporterTeam || ''}</div>
                  </div>
                </td>
                <td width="25%" style="padding-right:8px;padding-left:8px;">
                  <div style="background:#f0fff4;border-radius:10px;padding:20px 12px;text-align:center;">
                    <div style="font-size:13px;color:#666;margin-bottom:8px;">보고 일자</div>
                    <div style="font-size:16px;font-weight:700;color:#639922;">${report.date || now.toISOString().slice(0,10)}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">오늘</div>
                  </div>
                </td>
                <td width="25%" style="padding-right:8px;padding-left:8px;">
                  <div style="background:#f0f7ff;border-radius:10px;padding:20px 12px;text-align:center;">
                    <div style="font-size:13px;color:#666;margin-bottom:8px;">발신</div>
                    <div style="font-size:13px;font-weight:700;color:#378ADD;">${process.env.SMTP_USER || ''}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">보고 시스템</div>
                  </div>
                </td>
                <td width="25%" style="padding-left:8px;">
                  <div style="background:#fff0f0;border:2px solid #e74c3c;border-radius:10px;padding:20px 12px;text-align:center;">
                    <div style="font-size:13px;color:#666;margin-bottom:8px;">보고 유형</div>
                    <div style="font-size:16px;font-weight:700;color:#e74c3c;">일일</div>
                    <div style="font-size:12px;color:#e74c3c;margin-top:4px;">업무보고</div>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- 구분선 -->
        <tr><td style="border-top:1px solid #eee;padding-bottom:24px;"></td></tr>

        <!-- 보고 내용 -->
        <tr>
          <td style="padding-bottom:28px;">
            <div style="font-size:18px;font-weight:700;color:#1a1a2e;margin-bottom:16px;">📋 보고 내용</div>
            <div style="background:#fff;border-radius:10px;border:1px solid #e8e8e8;padding:24px;font-size:14px;line-height:1.9;color:#222;">
              ${bodyHtml}
            </div>
          </td>
        </tr>

        <!-- 구분선 -->
        <tr><td style="border-top:1px solid #eee;padding-bottom:16px;"></td></tr>

        <!-- 푸터 -->
        <tr>
          <td style="text-align:center;padding-bottom:8px;">
            <div style="font-size:12px;color:#aaa;">이 보고서는 일일보고 자동화 시스템에서 발송되었습니다.</div>
            <div style="font-size:12px;color:#aaa;margin-top:4px;">도서출판 성우 · 솔루션개발팀</div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

/**
 * 일일보고 메일 발송
 */
async function sendReport(report, recipients, reporterName, reporterTeam) {
  const htmlBody = buildHtmlEmail(report, reporterName, reporterTeam);

  const result = await transporter.sendMail({
    from: `"${reporterName || process.env.REPORTER_NAME}" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject: report.subject,
    text: report.body,
    html: htmlBody,
  });

  return result;
}

/**
 * SMTP 연결 테스트
 */
async function verifyConnection() {
  return transporter.verify();
}

module.exports = { sendReport, verifyConnection };

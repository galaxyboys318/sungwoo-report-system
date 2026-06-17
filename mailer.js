const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * 일일보고 메일 발송
 * @param {object} report - { subject, body, date }
 * @param {string[]} recipients - 수신자 이메일 배열
 */
async function sendReport(report, recipients) {
  // 본문을 HTML로 변환 (줄바꿈 → <br>, 들여쓰기 보존)
  const htmlBody = `
    <div style="font-family: 'Malgun Gothic', sans-serif; font-size: 14px; line-height: 1.8; color: #222;">
      <pre style="font-family: inherit; white-space: pre-wrap; word-break: keep-all;">${report.body}</pre>
    </div>
  `;

  const result = await transporter.sendMail({
    from: `"${process.env.REPORTER_NAME}" <${process.env.REPORTER_EMAIL}>`,
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

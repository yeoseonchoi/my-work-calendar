import nodemailer from 'nodemailer';

let transporter = null;
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE } = process.env;

if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: +(SMTP_PORT || 587),
    secure: SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    // 메일 서버가 응답하지 않을 때 함수가 오래 붙잡히지 않도록 시간 제한
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

export const mailConfigured = () => !!transporter;

// 발송한 메일의 사본을 받을 주소 (숨은참조). 보낸메일함에는 남지 않으므로 받은메일함에서 확인한다.
export const COPY_TO_SENDER = SMTP_USER || '';

// opts: { html, cc, bcc, replyTo }
export async function sendMail(to, subject, text, opts = {}) {
  if (!transporter) {
    console.log(`[메일 미설정 - 발송 생략] to=${to} subject=${subject}`);
    return false;
  }
  await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, ...(opts.html && { html: opts.html }), ...(opts.cc && { cc: opts.cc }), ...(opts.bcc && { bcc: opts.bcc }),...(opts.replyTo && { replyTo: opts.replyTo }) });
  return true;
}

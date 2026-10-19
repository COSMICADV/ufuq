import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@ufuq/config';
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail, close: vi.fn() }) },
}));
import { SmtpMailTransport } from './smtp-mail-transport.js';
const config: Env['mail'] = {
  smtpHost: 'smtp.test',
  smtpPort: 1025,
  smtpSecure: false,
  smtpUser: null,
  smtpPassword: null,
  from: 'UFUQ <sender@test.test>',
  contactTo: 'contact@test.test',
};
beforeEach(() => {
  sendMail.mockReset();
});
describe('SMTP transactional contact transport', () => {
  it('uses configured From and passes the validated Reply-To and recipient', async () => {
    sendMail.mockResolvedValue({ accepted: ['contact@test.test'] });
    await new SmtpMailTransport(config).send({
      to: 'contact@test.test',
      replyTo: 'visitor@test.test',
      subject: 'Enquiry',
      text: 'text',
      html: '<p>text</p>',
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: config.from,
      to: 'contact@test.test',
      replyTo: 'visitor@test.test',
      subject: 'Enquiry',
      text: 'text',
      html: '<p>text</p>',
    });
  });
  it('propagates a rejected delivery to the caller for generic error handling', async () => {
    sendMail.mockRejectedValue(new Error('SMTP rejected'));
    await expect(
      new SmtpMailTransport(config).send({
        to: 'contact@test.test',
        subject: 'Enquiry',
        text: 'text',
        html: '<p>text</p>',
      }),
    ).rejects.toThrow();
  });
});

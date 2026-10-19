import { describe, it, expect } from 'vitest';
import { contactMessage } from './contact-message.js';
import { PublicSiteService } from './public.service.js';
import type { Env } from '@ufuq/config';
import type { ContactDto } from './public.dto.js';
const dto = {
  name: 'Sara',
  company: 'Company',
  email: 'sara@test.test',
  phone: '+20100000000',
  message: 'Hello world',
  enquiry_type: 'pricing',
} as ContactDto;
describe('contact recipient configuration', () => {
  it('takes the recipient from configuration and never from submitted fields', () => {
    expect(contactMessage('configured@test.test', dto).to).toBe('configured@test.test');
  });
  it('fails safely when CONTACT_TO is absent', async () => {
    const service = new PublicSiteService(
      { mail: {} } as Env,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    await expect(service.contact(dto)).rejects.toMatchObject({
      appErrorCode: 'CONTACT_DELIVERY_FAILED',
    });
  });
});

import { expect, test } from '@playwright/test';
import { login, shots, trackErrors } from './helpers';

test('the desktop loads without console errors', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await shots(page, 'T-01-scaffold');
  expect(errors).toEqual([]);
});

import { expect, test } from '@playwright/test';
import { login, setTheme, shots, trackErrors } from './helpers';

const FONTS = ['Bricolage Grotesque Variable', 'Instrument Sans Variable', 'JetBrains Mono Variable'];

test('the design system applies both themes and loads its bundled fonts', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);

  const desktop = page.getByTestId('desktop');
  const background = () => desktop.evaluate((node) => getComputedStyle(node).backgroundColor);

  await setTheme(page, 'light');
  const light = await background();
  await setTheme(page, 'dark');
  const dark = await background();
  expect(light).toBe('rgb(244, 241, 234)');
  expect(dark).toBe('rgb(16, 18, 22)');
  expect(light).not.toBe(dark);

  // The fonts are bundled with the client: nothing is fetched from another origin.
  const foreign: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(page.url()).origin) foreign.push(request.url());
  });
  await page.evaluate(async (families) => {
    await Promise.all(families.map((family) => document.fonts.load(`16px "${family}"`)));
  }, FONTS);
  for (const family of FONTS) {
    // check() is also true for a family nobody declared, so require a loaded face as well.
    const loaded = await page.evaluate(
      (f) =>
        document.fonts.check(`16px "${f}"`) &&
        [...document.fonts].some((face) => face.family.replace(/["']/g, '') === f && face.status === 'loaded'),
      family,
    );
    expect(loaded, family).toBe(true);
  }
  const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(body).toContain('Instrument Sans Variable');
  expect(foreign).toEqual([]);

  // The wallpaper is drawn, fills the screen and recolours with the theme.
  const wallpaper = page.getByTestId('wallpaper');
  await expect(wallpaper).toBeVisible();
  const box = await wallpaper.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
  const contour = () =>
    page.locator('.wallpaper__contour').first().evaluate((node) => getComputedStyle(node).stroke);
  const darkContour = await contour();
  await setTheme(page, 'light');
  expect(await contour()).not.toBe(darkContour);

  await shots(page, 'T-12-desktop');
  expect(errors).toEqual([]);
});

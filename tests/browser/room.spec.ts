import { expect, test, type Browser, type Page } from '@playwright/test';

const SLATE_SIZE = 20;

async function createRoom(
  page: Page,
): Promise<{ invitePath: string; hostPath: string }> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create room' }).click();
  // Creating a room lands straight on the host controls at the host URL.
  await expect(
    page.getByRole('heading', { name: 'Host controls' }),
  ).toBeVisible();
  const invitePath = new URL(
    (await page.locator('.link-row a').first().getAttribute('href')) ?? '',
    'http://127.0.0.1',
  ).pathname;
  const hostPath = new URL(page.url()).pathname;
  expect(hostPath.startsWith('/host/')).toBe(true);
  return { invitePath, hostPath };
}

/** A participant in its own browser context, so sessions cannot be shared. */
async function joinAs(
  browser: Browser,
  invitePath: string,
  name: string,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(invitePath);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(
    page.getByRole('heading', { name: 'Waiting for the host to start' }),
  ).toBeVisible();
  return page;
}

async function voteThroughSlate(
  page: Page,
  choose: (position: number) => 'Yes' | 'No',
): Promise<void> {
  for (let position = 1; position <= SLATE_SIZE; position += 1) {
    await expect(page.getByRole('status')).toHaveText(
      `Movie ${position.toString()} of ${SLATE_SIZE.toString()}`,
    );
    await page.getByRole('button', { name: choose(position) }).click();
  }
  // The last participant to finish completes the room and lands on results;
  // everyone else waits.
  await expect(
    page.getByRole('heading', { name: /You are done|Results/u }),
  ).toBeVisible({ timeout: 15_000 });
}

test('four isolated participants complete a room and see one ranking', async ({
  browser,
  page,
}) => {
  const { invitePath, hostPath } = await createRoom(page);

  const ana = await joinAs(browser, invitePath, 'Ana');
  const bo = await joinAs(browser, invitePath, 'Bo');
  const cy = await joinAs(browser, invitePath, 'Cy');
  const dee = await joinAs(browser, invitePath, 'Dee');

  // The lobby list updates by short polling in every participant window.
  await expect(ana.locator('.people li')).toHaveCount(4);

  const host = await browser.newPage();
  await host.goto(hostPath);
  await expect(
    host.getByRole('button', { name: /Start voting \(4 joined\)/u }),
  ).toBeVisible();
  await host.getByRole('button', { name: /Start voting/u }).click();

  // Everyone approves movie 1; only Ana approves movie 2.
  await voteThroughSlate(ana, (position) => (position <= 2 ? 'Yes' : 'No'));
  await voteThroughSlate(bo, (position) => (position === 1 ? 'Yes' : 'No'));
  await voteThroughSlate(cy, (position) => (position === 1 ? 'Yes' : 'No'));

  // Results stay hidden while one participant is still voting.
  await expect(ana.getByRole('heading', { name: 'Results' })).toHaveCount(0);

  await voteThroughSlate(dee, (position) => (position === 1 ? 'Yes' : 'No'));

  for (const participant of [ana, bo, cy, dee]) {
    await expect(
      participant.getByRole('heading', { name: 'Results' }),
    ).toBeVisible({ timeout: 15_000 });
  }

  const rows = ana.locator('.results li');
  await expect(rows).toHaveCount(SLATE_SIZE);
  await expect(rows.nth(0)).toContainText('100% (4/4)');
  await expect(rows.nth(0).locator('.badge')).toHaveText('Match');
  await expect(rows.nth(1)).toContainText('25% (1/4)');
  await expect(rows.nth(1).locator('.badge')).toHaveCount(0);

  // Every participant and the host see the identical top row.
  const topTitle = await rows.nth(0).locator('.name').innerText();
  for (const other of [bo, cy, dee, host]) {
    await expect(
      other.locator('.results li').nth(0).locator('.name'),
    ).toHaveText(topTitle);
  }
});

test('the host can keep voting with a recommended second round', async ({
  browser,
  page,
}) => {
  // Two participants through two full rounds is eighty real votes in a real
  // browser — comfortably the heaviest test here, and the first to blow the
  // default budget when the machine is doing anything else. The length is the
  // point of the test, so it gets more time rather than fewer votes.
  test.slow();
  const { invitePath, hostPath } = await createRoom(page);
  const ana = await joinAs(browser, invitePath, 'Ana');
  const bo = await joinAs(browser, invitePath, 'Bo');

  const host = await browser.newPage();
  await host.goto(hostPath);
  await host.getByRole('button', { name: /Start voting/u }).click();

  // A consistent taste, so round two has something to work from.
  await voteThroughSlate(ana, (position) => (position <= 8 ? 'Yes' : 'No'));
  await voteThroughSlate(bo, (position) => (position <= 8 ? 'Yes' : 'No'));

  const firstResults = ana.locator('.results li');
  await expect(firstResults).toHaveCount(SLATE_SIZE, { timeout: 15_000 });
  const firstTitles = await firstResults.locator('.name').allInnerTexts();

  // Only the host is offered another round.
  await expect(ana.getByRole('button', { name: 'Keep voting' })).toHaveCount(0);
  const keepVoting = host.getByRole('button', { name: 'Keep voting' });
  await expect(keepVoting).toBeVisible({ timeout: 15_000 });
  await keepVoting.click();

  // Voting reopens for everyone, labelled as round two.
  await expect(ana.getByText('Round 2')).toBeVisible({ timeout: 15_000 });
  await expect(ana.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );
  // The card carries the score that put it on the slate, so a voter can see
  // the recommender is doing something rather than reshuffling.
  await expect(ana.locator('.pick-score')).toContainText('predicted match');

  await voteThroughSlate(ana, () => 'Yes');
  await voteThroughSlate(bo, () => 'Yes');

  await expect(
    ana.getByRole('heading', { name: 'Results — round 2' }),
  ).toBeVisible({ timeout: 15_000 });
  const secondRows = ana.locator('.results li');
  await expect(secondRows).toHaveCount(SLATE_SIZE);

  // Nothing from round one comes back, and every pick is explained.
  const secondTitles = await secondRows.locator('.name').allInnerTexts();
  for (const title of secondTitles) {
    expect(firstTitles).not.toContain(title);
  }
  await expect(secondRows.nth(0).locator('.reason')).not.toBeEmpty();

  // Results carry the prediction next to the outcome. Exploration slots are
  // unscored, so only the scored majority of the slate shows one.
  const predicted = await secondRows.locator('.predicted').count();
  expect(predicted).toBeGreaterThan(SLATE_SIZE / 2);
});

test('a refreshed participant resumes at the same card', async ({
  browser,
  page,
}) => {
  const { invitePath, hostPath } = await createRoom(page);
  const solo = await joinAs(browser, invitePath, 'Solo');

  const host = await browser.newPage();
  await host.goto(hostPath);
  await host.getByRole('button', { name: /Start voting/u }).click();

  await expect(solo.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );
  await solo.getByRole('button', { name: 'Yes' }).click();
  await expect(solo.getByRole('status')).toHaveText(
    `Movie 2 of ${SLATE_SIZE.toString()}`,
  );
  const secondTitle = await solo.locator('.card h2').innerText();

  await solo.reload();
  await expect(solo.getByRole('status')).toHaveText(
    `Movie 2 of ${SLATE_SIZE.toString()}`,
  );
  await expect(solo.locator('.card h2')).toHaveText(secondTitle);
});

test('the arrow keys vote like the buttons', async ({ browser, page }) => {
  const { invitePath, hostPath } = await createRoom(page);
  const solo = await joinAs(browser, invitePath, 'Keys');

  const host = await browser.newPage();
  await host.goto(hostPath);
  await host.getByRole('button', { name: /Start voting/u }).click();

  await expect(solo.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );
  await solo.keyboard.press('ArrowRight');
  await expect(solo.getByRole('status')).toHaveText(
    `Movie 2 of ${SLATE_SIZE.toString()}`,
  );
  await solo.keyboard.press('ArrowLeft');
  await expect(solo.getByRole('status')).toHaveText(
    `Movie 3 of ${SLATE_SIZE.toString()}`,
  );
});

test('an early close keeps non-responses in the denominator', async ({
  browser,
  page,
}) => {
  const { invitePath, hostPath } = await createRoom(page);
  const ana = await joinAs(browser, invitePath, 'Ana');
  await joinAs(browser, invitePath, 'Bo');
  await joinAs(browser, invitePath, 'Cy');
  await joinAs(browser, invitePath, 'Dee');

  const host = await browser.newPage();
  await host.goto(hostPath);
  await host.getByRole('button', { name: /Start voting/u }).click();

  await expect(ana.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );
  await ana.getByRole('button', { name: 'Yes' }).click();

  host.on('dialog', (dialog) => void dialog.accept());
  await host.getByRole('button', { name: 'Close voting now' }).click();

  await expect(host.getByRole('heading', { name: 'Results' })).toBeVisible({
    timeout: 15_000,
  });
  const top = host.locator('.results li').nth(0);
  await expect(top).toContainText('25% (1/4)');
  await expect(top).toContainText('25% answered');
  await expect(host.locator('.results li .badge')).toHaveCount(0);
});

test('a phone can scroll the voting card without voting', async ({
  browser,
  page,
}) => {
  const { invitePath, hostPath } = await createRoom(page);

  // A viewport short enough that the card genuinely overflows it, which is the
  // condition the gesture and the pinned buttons both exist for.
  const context = await browser.newContext({
    viewport: { width: 390, height: 640 },
    hasTouch: true,
    isMobile: true,
  });
  const phone = await context.newPage();
  await phone.goto(invitePath);
  await phone.getByLabel('Display name').fill('Thumb');
  await phone.getByRole('button', { name: 'Join room' }).click();

  const host = await browser.newPage();
  await host.goto(hostPath);
  await host.getByRole('button', { name: /Start voting/u }).click();

  await expect(phone.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );
  const card = phone.locator('.card');
  const box = await card.boundingBox();
  if (box === null) throw new Error('The card is not laid out');
  const startX = box.x + box.width / 2;
  const startY = box.y + 40;

  // A touch that travels vertically is the page being scrolled, not a vote.
  // The card must let it go rather than treating it as a swipe.
  const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true };
  await card.dispatchEvent('pointerdown', {
    ...pointer,
    clientX: startX,
    clientY: startY,
  });
  for (const travelled of [40, 120, 220]) {
    await card.dispatchEvent('pointermove', {
      ...pointer,
      clientX: startX,
      clientY: startY - travelled,
    });
  }
  await card.dispatchEvent('pointerup', {
    ...pointer,
    clientX: startX,
    clientY: startY - 220,
  });
  await expect(phone.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );

  // The choices stay on screen once the page has been scrolled down the card.
  await phone.evaluate(() => {
    globalThis.scrollTo(0, 300);
  });
  await expect
    .poll(async () => phone.evaluate(() => globalThis.scrollY))
    .toBeGreaterThan(0);
  await expect(phone.getByRole('button', { name: 'Yes' })).toBeInViewport();

  // And they still vote from where they are pinned.
  await phone.getByRole('button', { name: 'Yes' }).click();
  await expect(phone.getByRole('status')).toHaveText(
    `Movie 2 of ${SLATE_SIZE.toString()}`,
  );
});

test('a horizontal drag across the card still votes', async ({
  browser,
  page,
}) => {
  const { invitePath, hostPath } = await createRoom(page);
  const solo = await joinAs(browser, invitePath, 'Dragger');

  const host = await browser.newPage();
  await host.goto(hostPath);
  await host.getByRole('button', { name: /Start voting/u }).click();

  await expect(solo.getByRole('status')).toHaveText(
    `Movie 1 of ${SLATE_SIZE.toString()}`,
  );
  const box = await solo.locator('.card').boundingBox();
  if (box === null) throw new Error('The card is not laid out');
  const y = box.y + 40;

  await solo.mouse.move(box.x + box.width / 2, y);
  await solo.mouse.down();
  // Past the 90px commit threshold, to the right: a yes.
  await solo.mouse.move(box.x + box.width / 2 + 60, y);
  await solo.mouse.move(box.x + box.width / 2 + 160, y);
  await solo.mouse.up();

  await expect(solo.getByRole('status')).toHaveText(
    `Movie 2 of ${SLATE_SIZE.toString()}`,
  );
});

test('an invalid invite reveals nothing', async ({ page }) => {
  await page.goto(`/join/${'z'.repeat(43)}`);
  await expect(
    page.getByRole('heading', { name: 'This invite is not available' }),
  ).toBeVisible();
});

test('the privacy notice and source offer are reachable from any page', async ({
  page,
}) => {
  await page.goto('/');

  // Both obligations live in the footer: the notice a participant is owed
  // before they type a name, and the AGPL's offer of source.
  await page.getByRole('link', { name: 'What Quorum knows about you' }).click();

  await expect(
    page.getByRole('heading', { name: 'What Quorum knows about you' }),
  ).toBeVisible();
  await expect(page.getByText('No account, no email')).toBeVisible();
  await expect(page.getByText('AGPL-3.0-or-later')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Source' })).toBeVisible();

  // This instance runs on the fixture catalogue, which is synthetic and uses no
  // TMDB data. TMDB branding is owed only where their data is actually shown,
  // so the credits section and its logo must be absent here. The positive case
  // needs an imported TMDB catalogue, which needs a credential CI does not have.
  await expect(
    page.getByRole('heading', { name: 'Where the movie data comes from' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: 'The Movie Database (TMDB)' }),
  ).toHaveCount(0);
});

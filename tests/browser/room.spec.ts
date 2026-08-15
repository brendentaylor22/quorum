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

test('an invalid invite reveals nothing', async ({ page }) => {
  await page.goto(`/join/${'z'.repeat(43)}`);
  await expect(
    page.getByRole('heading', { name: 'This invite is not available' }),
  ).toBeVisible();
});

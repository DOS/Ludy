// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's SUCCESSFUL proposal on a sales e-invoice draft (#2713, review follow-up of #2712). The default stack has no model, so the one HTTP call to the model-backed route is stubbed at
// the browser: the app, the rendering of the proposal and the draft save are the real ones. It shows what a person sees (the line and the buyer filled and marked as the coworker's, the VAT source note),
// that the box is locked while a request is pending, that an edit removes the mark, that the form's buyer travels with the next request, and that the draft saves.
import { expect, test } from "@playwright/test";
import { exec, sql } from "../lib/db.ts";
import { createOrg, newEmail, signUp } from "../lib/session.ts";

const ASK = "**/api/rpc/einvoice/drafts/suggest";

test("a proposal fills the form marked as the coworker's, the box is locked while it waits, an edit clears the mark and the draft saves (#2713)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await signUp(page, newEmail("einvoice-proposal"));
  const slug = await createOrg(page, "Công ty Đề Xuất Hóa Đơn E2E");
  exec(
    `INSERT INTO ludy_kernel.party (org_id, name, kind) SELECT org_id, 'Nguyễn Văn Nam', 'person' FROM ludy_kernel.tenant WHERE slug = :'slug'`,
    { slug },
  );
  const [customer] = sql<{ id: string }>(
    `SELECT p.id FROM ludy_kernel.party p JOIN ludy_kernel.tenant t ON t.org_id = p.org_id WHERE t.slug = :'slug' AND p.name = 'Nguyễn Văn Nam'`,
    { slug },
  );
  expect(customer?.id).toBeTruthy();

  const proposal = {
    ai: "used",
    lines: [
      {
        description: "Bánh A",
        unit: "hộp",
        quantity: "10",
        unitPrice: "120000",
        vatRate: "8%",
        vatFrom: "earlier",
      },
    ],
    buyer: {
      kind: "individual",
      partyId: customer?.id,
      taxCode: null,
      name: "Nguyễn Văn Nam",
      address: "5 Phố Nam, Huế",
      email: null,
      identityKind: null,
      identity: null,
    },
  };
  const sent: unknown[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route(ASK, async (route) => {
    calls += 1;
    sent.push((route.request().postDataJSON() as { json: unknown }).json);
    if (calls === 1) await held;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: proposal }),
    });
  });

  const nav = page.getByRole("navigation");
  await nav.getByRole("link", { name: "Tài chính", exact: true }).click();
  await nav.getByRole("link", { name: "Hóa đơn bán ra" }).click();
  await page.getByTestId("invoice-new").click();
  const form = page.getByTestId("invoice-form");
  const text = page.getByTestId("invoice-ai-text");

  await test.step("while the request waits the box is locked and cannot be asked again", async () => {
    await text.fill("bán 10 hộp bánh A giá 120k cho anh Nam");
    await page.getByTestId("invoice-ai-ask").click();
    await expect(text).toBeDisabled();
    await expect(page.getByTestId("invoice-ai-ask")).toBeDisabled();
    release();
    await expect(text).toBeEnabled();
  });

  await test.step("the line and the buyer are filled and marked as the coworker's, with where the VAT rate came from", async () => {
    await expect(page.getByTestId("invoice-ai-state")).toHaveAttribute(
      "data-state",
      "filled",
    );
    await expect(form.getByLabel("Tên hàng hóa, dịch vụ").first()).toHaveValue(
      "Bánh A",
    );
    await expect(form.getByLabel("Số lượng").first()).toHaveValue("10");
    await expect(form.getByLabel("Đơn giá").first()).toHaveValue("120000");
    await expect(form.getByLabel("Thuế suất").first()).toHaveValue("8%");
    await expect(page.getByTestId("invoice-line-ai")).toContainText(
      "Thuế suất lấy từ các bản nháp trước, đoạn chữ không nêu thuế suất.",
    );
    await expect(form.getByLabel("Tên người mua", { exact: true })).toHaveValue(
      "Nguyễn Văn Nam",
    );
    await expect(page.getByTestId("invoice-buyer-ai")).toContainText(
      "Người mua lấy từ hồ sơ khách hàng trong sổ.",
    );
  });

  await test.step("editing a field removes its mark, and the amounts come from the server", async () => {
    await form.getByLabel("Đơn giá").first().fill("125000");
    await expect(page.getByTestId("invoice-line-ai")).toHaveCount(0);
    await form.getByLabel("Địa chỉ", { exact: true }).fill("7 Phố Nam, Huế");
    await expect(page.getByTestId("invoice-buyer-ai")).toHaveCount(0);
    await expect(page.getByTestId("invoice-total")).toContainText(
      /1\.350\.000/,
    );
  });

  await test.step("asking again sends the buyer the form names, so the rate history is that customer's (item 1)", async () => {
    await text.fill("thêm 2 hộp bánh B giá 50k");
    await page.getByTestId("invoice-ai-ask").click();
    await expect(page.getByTestId("invoice-ai-state")).toHaveAttribute(
      "data-state",
      "filled",
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty("formBuyerPartyId");
    expect(sent[1]).toMatchObject({ formBuyerPartyId: customer?.id });
  });

  await test.step("the draft saves and shows in the list", async () => {
    await page.getByTestId("invoice-save").click();
    await expect(form).toBeHidden();
    await expect(page.getByTestId("invoice-draft")).toContainText("Bản nháp");
  });
});

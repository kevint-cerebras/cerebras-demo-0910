import type { Page } from "playwright";
import { showNativePage, warmBrowser } from "./browser";

let currentPage: Page | undefined;
export async function adoptGeneralPage(page: Page) {
  currentPage = page;
}
export async function showGeneralBrowser() {
  const page =
    currentPage && !currentPage.isClosed()
      ? currentPage
      : (await warmBrowser()).pages.goodmarket;
  await showNativePage(page);
  return { url: page.url(), title: await page.title() };
}

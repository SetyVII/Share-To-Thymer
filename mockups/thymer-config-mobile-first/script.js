const stage = document.querySelector("#stage");
const viewportButtons = document.querySelectorAll("[data-size]");
const ruleList = document.querySelector("#ruleList");
const restrictionList = document.querySelector("#restrictionList");
const emptyRules = document.querySelector("[data-empty-rules]");
const emptyRestrictions = document.querySelector("[data-empty-restrictions]");

let ruleCount = 0;
let restrictionCount = 0;

viewportButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const size = button.dataset.size;
    viewportButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    stage.classList.toggle("stage-mobile", size === "mobile");
    stage.classList.toggle("stage-desktop", size === "desktop");
  });
});

document.querySelector("#addRule").addEventListener("click", () => {
  ruleCount += 1;
  emptyRules.hidden = true;
  ruleList.hidden = false;
  ruleList.insertAdjacentHTML(
    "beforeend",
    `
      <div class="rule-row">
        <label>
          <span class="field-label">Domain</span>
          <input type="text" value="${ruleCount === 1 ? "github.com" : `domain-${ruleCount}.com`}" placeholder="domain">
        </label>
        <span class="arrow" aria-hidden="true">&rarr;</span>
        <label>
          <span class="field-label">Tag</span>
          <input type="text" value="${ruleCount === 1 ? "code" : "tag"}" placeholder="tag">
        </label>
      </div>
    `,
  );
});

document.querySelector("#addRestriction").addEventListener("click", () => {
  restrictionCount += 1;
  emptyRestrictions.hidden = true;
  restrictionList.hidden = false;
  restrictionList.insertAdjacentHTML(
    "beforeend",
    `
      <div class="restriction-row">
        <div class="restriction-header">
          <strong>${restrictionCount === 1 ? "Journal" : "Bookmarks"}</strong>
          <button class="delete-button" type="button">Delete</button>
        </div>
        <span class="tag-preview">${restrictionCount === 1 ? "mobile, reference, read-later" : "tag1, tag2, tag3"}</span>
      </div>
    `,
  );
});

restrictionList.addEventListener("click", (event) => {
  if (!event.target.matches(".delete-button")) return;
  event.target.closest(".restriction-row").remove();
  if (!restrictionList.children.length) {
    restrictionList.hidden = true;
    emptyRestrictions.hidden = false;
  }
});

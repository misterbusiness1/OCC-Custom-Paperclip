import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  currentUserRedactionProfileSha256,
  maskUserNameForLogs,
  redactCurrentUserText,
  redactCurrentUserValue,
} from "../log-redaction.js";

describe("log redaction", () => {
  it.each(["h", "é", "🧑"])("fully masks a one-character username %s", (userName) => {
    expect(maskUserNameForLogs(userName)).toBe("*");
    expect(maskUserNameForLogs(userName, "[user]")).toBe("[user]");
  });

  it.each(["h", "é", "🧑"])("removes the complete home path for username %s", (userName) => {
    const homeDir = `/home/${userName}`;
    const result = redactCurrentUserText(`read failed at ${homeDir}/workspace/report.log`, {
      userNames: [userName],
      homeDirs: [homeDir],
    });
    expect(result).toBe("read failed at /home/*/workspace/report.log");
    expect(result).not.toContain(homeDir);
  });

  it("retains a complete first Unicode code point when partially masking a longer name", () => {
    expect(maskUserNameForLogs("🧑Agent")).toBe("🧑*****");
  });

  it("redacts the active username inside home-directory paths", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const input = [
      `cwd=/Users/${userName}/paperclip`,
      `home=/home/${userName}/workspace`,
      `win=C:\\Users\\${userName}\\paperclip`,
    ].join("\n");

    const result = redactCurrentUserText(input, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`, `C:\\Users\\${userName}`],
    });

    expect(result).toContain(`cwd=/Users/${maskedUserName}/paperclip`);
    expect(result).toContain(`home=/home/${maskedUserName}/workspace`);
    expect(result).toContain(`win=C:\\Users\\${maskedUserName}\\paperclip`);
    expect(result).not.toContain(userName);
  });

  it("redacts standalone username mentions without mangling larger tokens", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserText(
      `user ${userName} said ${userName}/project should stay but apaperclipuserz should not change`,
      {
        userNames: [userName],
        homeDirs: [],
      },
    );

    expect(result).toBe(
      `user ${maskedUserName} said ${maskedUserName}/project should stay but apaperclipuserz should not change`,
    );
  });

  it("recursively redacts nested event payloads", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserValue({
      cwd: `/Users/${userName}/paperclip`,
      prompt: `open /Users/${userName}/paperclip/ui`,
      nested: {
        author: userName,
      },
      values: [userName, `/home/${userName}/project`],
    }, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`],
    });

    expect(result).toEqual({
      cwd: `/Users/${maskedUserName}/paperclip`,
      prompt: `open /Users/${maskedUserName}/paperclip/ui`,
      nested: {
        author: maskedUserName,
      },
      values: [maskedUserName, `/home/${maskedUserName}/project`],
    });
  });

  it("skips redaction when disabled", () => {
    const input = "cwd=/Users/paperclipuser/paperclip";
    expect(redactCurrentUserText(input, { enabled: false })).toBe(input);
  });
});


describe("captured redaction profile compatibility", () => {
  function legacyProfile(userNames: string[], homeDirs: string[]) {
    return createHash("sha256").update(JSON.stringify({ version: 1,
      userNames: [...userNames].sort(), homeDirs: [...homeDirs].sort(), replacement: "*",
    })).digest("hex");
  }

  it.each(["paperclipuser", "éclair", "a🧑"])("retains the captured v1 identity for unchanged masking of %s", (name) => {
    const opts = { userNames: [name], homeDirs: [`/home/${name}`] };
    expect(currentUserRedactionProfileSha256(true, opts)).toBe(legacyProfile(opts.userNames, opts.homeDirs));
  });

  it.each(["h", "é", "🧑", "🧑Agent"])("invalidates the captured v1 rule when masking changes for %s", (name) => {
    const opts = { userNames: [name], homeDirs: [] };
    expect(currentUserRedactionProfileSha256(true, opts)).not.toBe(legacyProfile(opts.userNames, opts.homeDirs));
  });

  it.each(["/home/h", "C:\\Users\\🧑Agent\\"])("detects changed home-path masking independently of usernames: %s", (homeDir) => {
    const opts = { userNames: ["ordinary"], homeDirs: [homeDir] };
    expect(currentUserRedactionProfileSha256(true, opts)).not.toBe(legacyProfile(opts.userNames, opts.homeDirs));
  });

  it("retains the disabled profile identity", () => {
    expect(currentUserRedactionProfileSha256(false, { userNames: ["h"], homeDirs: ["/home/h"] })).toBe("disabled");
  });
});

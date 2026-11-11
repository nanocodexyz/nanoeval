const IGNORED: [&str; 6] = [
    "EXPOSE",
    "HEALTHCHECK",
    "LABEL",
    "MAINTAINER",
    "STOPSIGNAL",
    "VOLUME",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Exec(Vec<String>),
    Shell(String),
}

impl Command {
    fn parse(text: &str) -> Self {
        if text.starts_with('[')
            && let Ok(arguments) = serde_json::from_str::<Vec<String>>(text)
        {
            return Self::Exec(arguments);
        }
        Self::Shell(text.to_owned())
    }

    pub(crate) fn arguments(&self, shell: &[String]) -> Vec<String> {
        match self {
            Self::Exec(arguments) => arguments.clone(),
            Self::Shell(command) => shell.iter().cloned().chain([command.clone()]).collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Instruction {
    Arg(String),
    Cmd(Command),
    Copy {
        add: bool,
        from: Option<String>,
        paths: String,
    },
    Entrypoint(Command),
    Env(String),
    From {
        image: String,
        name: Option<String>,
    },
    Ignored,
    Run(Command),
    Shell(Vec<String>),
    User(String),
    Workdir(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Step {
    pub(crate) instruction: Instruction,
    pub(crate) line: usize,
}

fn logical(text: &str) -> Result<Vec<(usize, String)>, String> {
    let mut lines = Vec::new();
    let mut current: Option<(usize, String)> = None;
    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let trimmed = raw.trim();
        if trimmed.starts_with('#') {
            if let Some(escape) = trimmed
                .trim_start_matches('#')
                .trim_start()
                .strip_prefix("escape=")
                && current.is_none()
                && lines.is_empty()
                && escape.trim() != "\\"
            {
                return Err(format!(
                    "line {number}: the escape directive is not supported"
                ));
            }
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        let (start, mut joined) = current.take().unwrap_or((number, String::new()));
        if let Some(fragment) = trimmed.strip_suffix('\\') {
            joined.push_str(fragment);
            current = Some((start, joined));
        } else {
            joined.push_str(trimmed);
            lines.push((start, joined));
        }
    }
    if let Some((start, _)) = current {
        return Err(format!("line {start}: the instruction does not end"));
    }
    Ok(lines)
}

fn heredoc(text: &str) -> bool {
    text.match_indices("<<").any(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + 2..].chars().next();
        before != Some('<')
            && after.is_some_and(|next| next.is_alphanumeric() || "-_'\"".contains(next))
    })
}

fn flags(text: &str) -> (Vec<(&str, &str)>, &str) {
    let mut flags = Vec::new();
    let mut rest = text;
    while let Some(flag) = rest.strip_prefix("--") {
        let (word, tail) = flag.split_once(char::is_whitespace).unwrap_or((flag, ""));
        flags.push(word.split_once('=').unwrap_or((word, "")));
        rest = tail.trim_start();
    }
    (flags, rest)
}

fn instruction(keyword: &str, rest: &str) -> Result<Instruction, String> {
    let (flags, body) = flags(rest);
    let refuse = |name: &str| format!("{keyword} --{name} is not supported");
    let plain = || match flags.first() {
        Some((name, _)) => Err(refuse(name)),
        None if body.is_empty() => Err(format!("{keyword} needs an argument")),
        None => Ok(body.to_owned()),
    };
    match keyword {
        "ADD" => Ok(Instruction::Copy {
            add: true,
            from: None,
            paths: plain()?,
        }),
        "ARG" => plain().map(Instruction::Arg),
        "CMD" => Ok(Instruction::Cmd(Command::parse(rest))),
        "COPY" => {
            let mut from = None;
            for (name, value) in &flags {
                if *name != "from" || value.is_empty() {
                    return Err(refuse(name));
                }
                from = Some((*value).to_owned());
            }
            if body.is_empty() {
                return Err(format!("{keyword} needs an argument"));
            }
            Ok(Instruction::Copy {
                add: false,
                from,
                paths: body.to_owned(),
            })
        }
        "ENTRYPOINT" => Ok(Instruction::Entrypoint(Command::parse(rest))),
        "ENV" => plain().map(Instruction::Env),
        "FROM" => {
            let body = plain()?;
            let words = body.split_whitespace().collect::<Vec<_>>();
            match words.as_slice() {
                [image] => Ok(Instruction::From {
                    image: (*image).to_owned(),
                    name: None,
                }),
                [image, keyword, name] if keyword.eq_ignore_ascii_case("as") => {
                    Ok(Instruction::From {
                        image: (*image).to_owned(),
                        name: Some((*name).to_owned()),
                    })
                }
                _ => Err("FROM takes an image and an optional AS name".to_owned()),
            }
        }
        "RUN" => plain().map(|body| Instruction::Run(Command::parse(&body))),
        "SHELL" => serde_json::from_str::<Vec<String>>(rest)
            .ok()
            .filter(|shell| !shell.is_empty())
            .map(Instruction::Shell)
            .ok_or_else(|| "SHELL takes a JSON array".to_owned()),
        "USER" => plain().map(Instruction::User),
        "WORKDIR" => plain().map(Instruction::Workdir),
        _ if IGNORED.contains(&keyword) => Ok(Instruction::Ignored),
        _ => Err(format!("{keyword} is not supported")),
    }
}

pub(crate) fn parse(text: &str) -> Result<Vec<Step>, String> {
    logical(text)?
        .into_iter()
        .map(|(line, text)| {
            let (keyword, rest) = text
                .split_once(char::is_whitespace)
                .unwrap_or((text.as_str(), ""));
            let keyword = keyword.to_ascii_uppercase();
            let parsed = if matches!(keyword.as_str(), "ADD" | "COPY" | "RUN") && heredoc(rest) {
                Err(format!("a heredoc in {keyword} is not supported"))
            } else {
                instruction(&keyword, rest.trim())
            };
            parsed
                .map(|instruction| Step { instruction, line })
                .map_err(|message| format!("line {line}: {message}"))
        })
        .collect()
}

fn variable(
    characters: &mut std::iter::Peekable<std::str::Chars<'_>>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let named = |character: char| character == '_' || character.is_ascii_alphanumeric();
    if characters.next_if_eq(&'{').is_none() {
        let mut name = String::new();
        while let Some(character) = characters.next_if(|character| named(*character)) {
            name.push(character);
        }
        return Ok(if name.is_empty() {
            "$".to_owned()
        } else {
            lookup(&name).unwrap_or_default()
        });
    }
    let mut inside = String::new();
    loop {
        match characters.next() {
            Some('}') => break,
            Some(character) => inside.push(character),
            None => return Err("an expansion has no closing brace".to_owned()),
        }
    }
    let end = inside
        .find(|character| !named(character))
        .unwrap_or(inside.len());
    let (name, modifier) = inside.split_at(end);
    let value = lookup(name).filter(|value| !value.is_empty());
    match (modifier.get(..2), modifier.get(2..)) {
        _ if modifier.is_empty() => Ok(value.unwrap_or_default()),
        (Some(":-"), Some(word)) => Ok(value.unwrap_or_else(|| word.to_owned())),
        (Some(":+"), Some(word)) => Ok(value.map(|_| word.to_owned()).unwrap_or_default()),
        _ => Err(format!("the expansion of {inside} is not supported")),
    }
}

pub(crate) fn words(
    text: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            character if character.is_whitespace() => words.extend(word.take()),
            '\'' => {
                let word = word.get_or_insert_default();
                loop {
                    match characters.next() {
                        Some('\'') => break,
                        Some(character) => word.push(character),
                        None => return Err("a single quote is not closed".to_owned()),
                    }
                }
            }
            '"' => {
                let word = word.get_or_insert_default();
                loop {
                    match characters.next() {
                        Some('"') => break,
                        Some('\\') => match characters.next() {
                            Some(escaped) if "\"\\$".contains(escaped) => word.push(escaped),
                            Some(other) => {
                                word.push('\\');
                                word.push(other);
                            }
                            None => return Err("a double quote is not closed".to_owned()),
                        },
                        Some('$') => word.push_str(&variable(&mut characters, lookup)?),
                        Some(character) => word.push(character),
                        None => return Err("a double quote is not closed".to_owned()),
                    }
                }
            }
            '\\' => word.get_or_insert_default().extend(characters.next()),
            '$' => word
                .get_or_insert_default()
                .push_str(&variable(&mut characters, lookup)?),
            character => word.get_or_insert_default().push(character),
        }
    }
    words.extend(word);
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(name: &str) -> Option<String> {
        match name {
            "EMPTY" => Some(String::new()),
            "HOME" => Some("/root".to_owned()),
            _ => None,
        }
    }

    #[test]
    fn instructions_keep_their_first_line() {
        let steps = parse(
            "# syntax=docker/dockerfile:1\nFROM ubuntu:24.04 AS build\n\nRUN apt-get update && \\\n    # a comment inside\n    apt-get install -y curl\nCOPY --from=ghcr.io/astral-sh/uv:0.8.14 /uv /uvx /bin/\nCMD [\"sh\", \"-c\", \"true\"]\nEXPOSE 80\n",
        )
        .unwrap();
        assert_eq!(
            steps,
            vec![
                Step {
                    instruction: Instruction::From {
                        image: "ubuntu:24.04".to_owned(),
                        name: Some("build".to_owned()),
                    },
                    line: 2,
                },
                Step {
                    instruction: Instruction::Run(Command::Shell(
                        "apt-get update && apt-get install -y curl".to_owned()
                    )),
                    line: 4,
                },
                Step {
                    instruction: Instruction::Copy {
                        add: false,
                        from: Some("ghcr.io/astral-sh/uv:0.8.14".to_owned()),
                        paths: "/uv /uvx /bin/".to_owned(),
                    },
                    line: 7,
                },
                Step {
                    instruction: Instruction::Cmd(Command::Exec(vec![
                        "sh".to_owned(),
                        "-c".to_owned(),
                        "true".to_owned()
                    ])),
                    line: 8,
                },
                Step {
                    instruction: Instruction::Ignored,
                    line: 9,
                },
            ]
        );
    }

    #[test]
    fn what_is_not_supported_is_refused_by_name_with_its_line() {
        for (text, message) in [
            (
                "FROM a\nONBUILD RUN true",
                "line 2: ONBUILD is not supported",
            ),
            (
                "FROM a\nRUN --mount=type=cache,target=/x true",
                "line 2: RUN --mount is not supported",
            ),
            (
                "FROM a\n\nCOPY --chown=1:1 a /b",
                "line 3: COPY --chown is not supported",
            ),
            (
                "FROM --platform=linux/arm64 a",
                "line 1: FROM --platform is not supported",
            ),
            (
                "FROM a\nRUN cat <<EOF > /x\nhello\nEOF",
                "line 2: a heredoc in RUN is not supported",
            ),
            (
                "FROM a\nRUN true \\",
                "line 2: the instruction does not end",
            ),
            (
                "# escape=`\nFROM a",
                "line 1: the escape directive is not supported",
            ),
        ] {
            assert_eq!(parse(text).unwrap_err(), message);
        }
        assert!(parse("FROM a\nRUN cat <<< hello").is_ok());
    }

    #[test]
    fn words_split_quote_and_expand_as_a_dockerfile_does() {
        assert_eq!(
            words(
                r#"a="$HOME/x y" b='$HOME' c=\$HOME ${NONE:-d} ${HOME:+e}${EMPTY:+f} $"#,
                &lookup
            )
            .unwrap(),
            ["a=/root/x y", "b=$HOME", "c=$HOME", "d", "e", "$"]
        );
        assert_eq!(
            words("PYTHONPATH=/app:$PYTHONPATH", &lookup).unwrap(),
            ["PYTHONPATH=/app:"]
        );
        assert!(words("${HOME%x}", &lookup).unwrap_err().contains("HOME%x"));
        assert!(words("'open", &lookup).is_err());
    }

    #[test]
    fn a_shell_form_runs_under_the_stage_shell() {
        let shell = ["/bin/sh".to_owned(), "-c".to_owned()];
        assert_eq!(
            Command::parse("echo [a]").arguments(&shell),
            ["/bin/sh", "-c", "echo [a]"]
        );
        assert_eq!(
            Command::parse(r#"["echo", "a"]"#).arguments(&shell),
            ["echo", "a"]
        );
    }
}

use std::{
    io,
    net::Ipv4Addr,
    os::fd::{AsRawFd, OwnedFd},
};

use nix::{
    net::if_::if_nametoindex,
    sys::socket::{
        AddressFamily, MsgFlags, NetlinkAddr, SockFlag, SockProtocol, SockType, bind, recv, send,
        socket,
    },
};

const ACK: u16 = 0x004;
const CREATE: u16 = 0x400;
const ERROR: u16 = 2;
const EXCLUSIVE: u16 = 0x200;
const HEADER: usize = 16;
const NESTED: u16 = 0x8000;
const REQUEST: u16 = 0x001;

const ADDRESS_ADDRESS: u16 = 1;
const ADDRESS_LOCAL: u16 = 2;
const FAMILY_INET: u8 = 2;
const LINK_MTU: u16 = 4;
const LINK_UP: u32 = 1;
const NEW_ADDRESS: u16 = 20;
const NEW_LINK: u16 = 16;
const NEW_ROUTE: u16 = 24;
const ROUTE_GATEWAY: u16 = 5;
const ROUTE_INTERFACE: u16 = 4;
const ROUTE_MAIN: u8 = 254;
const ROUTE_STATIC: u8 = 4;
const ROUTE_UNICAST: u8 = 1;

const ACCEPT: u32 = 1;
const BATCH_BEGIN: u16 = 0x10;
const BATCH_END: u16 = 0x11;
const BITWISE_DESTINATION: u16 = 2;
const BITWISE_LENGTH: u16 = 3;
const BITWISE_MASK: u16 = 4;
const BITWISE_SOURCE: u16 = 1;
const BITWISE_XOR: u16 = 5;
const CHAIN_HOOK: u16 = 4;
const CHAIN_NAME: u16 = 3;
const CHAIN_POLICY: u16 = 5;
const CHAIN_TABLE: u16 = 1;
const CHAIN_TYPE: u16 = 7;
const COMPARE_DATA: u16 = 3;
const COMPARE_EQUAL: u32 = 0;
const COMPARE_OPERATION: u16 = 2;
const COMPARE_SOURCE: u16 = 1;
const COMPARE_UNEQUAL: u32 = 1;
const DATA_VALUE: u16 = 1;
const DATA_VERDICT: u16 = 2;
const DROP: u32 = 0;
const EXPRESSION_DATA: u16 = 2;
const EXPRESSION_NAME: u16 = 1;
const FAMILY_BOTH: u8 = 1;
const HOOK_INPUT: u32 = 1;
const HOOK_NUMBER: u16 = 1;
const HOOK_PRIORITY: u16 = 2;
const IMMEDIATE_DATA: u16 = 2;
const IMMEDIATE_DESTINATION: u16 = 1;
const INTERFACE_NAME_LENGTH: usize = 16;
const LIST_ELEMENT: u16 = 1;
const LOOKUP_DESTINATION: u16 = 1;
const LOOKUP_KEY: u16 = 2;
const META_INPUT_NAME: u32 = 6;
const NEW_CHAIN: u16 = TABLES << 8 | 3;
const NEW_RULE: u16 = TABLES << 8 | 6;
const NEW_TABLE: u16 = TABLES << 8;
const REGISTER: u32 = 1;
const REGISTER_VERDICT: u32 = 0;
const RULE_CHAIN: u16 = 2;
const RULE_EXPRESSIONS: u16 = 4;
const RULE_TABLE: u16 = 1;
const STATE: u32 = 0;
const STATE_ESTABLISHED: u32 = 1 << 1;
const STATE_RELATED: u32 = 1 << 2;
const TABLES: u16 = 10;
const TABLE_NAME: u16 = 1;
const VERDICT_CODE: u16 = 1;

const CHAIN: &str = "input";
const LOOPBACK: &str = "lo";
const TABLE: &str = "nanoeval";

#[derive(Default)]
struct Attributes(Vec<u8>);

impl Attributes {
    fn bytes(mut self, kind: u16, value: &[u8]) -> Self {
        let length = u16::try_from(4 + value.len()).expect("a netlink attribute fits 64 KiB");
        self.0.extend_from_slice(&length.to_ne_bytes());
        self.0.extend_from_slice(&kind.to_ne_bytes());
        self.0.extend_from_slice(value);
        self.0.resize(self.0.len().next_multiple_of(4), 0);
        self
    }

    fn nest(self, kind: u16, inner: &Self) -> Self {
        self.bytes(kind | NESTED, &inner.0)
    }

    fn number(self, kind: u16, value: u32) -> Self {
        self.bytes(kind, &value.to_be_bytes())
    }

    fn text(self, kind: u16, value: &str) -> Self {
        let mut bytes = value.as_bytes().to_vec();
        bytes.push(0);
        self.bytes(kind, &bytes)
    }

    fn value(self, kind: u16, value: &[u8]) -> Self {
        self.nest(kind, &Self::default().bytes(DATA_VALUE, value))
    }
}

fn message(kind: u16, flags: u16, header: &[u8], attributes: &Attributes) -> Vec<u8> {
    let length = HEADER + header.len() + attributes.0.len();
    let mut bytes = Vec::with_capacity(length);
    bytes.extend_from_slice(
        &u32::try_from(length)
            .expect("a netlink message fits 4 GiB")
            .to_ne_bytes(),
    );
    bytes.extend_from_slice(&kind.to_ne_bytes());
    bytes.extend_from_slice(&(REQUEST | flags).to_ne_bytes());
    bytes.extend_from_slice(&[0; 8]);
    bytes.extend_from_slice(header);
    bytes.extend_from_slice(&attributes.0);
    bytes
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> io::Result<[u8; N]> {
    bytes
        .get(offset..offset + N)
        .and_then(|field| field.try_into().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "a netlink reply is truncated"))
}

fn transact(protocol: SockProtocol, request: &[u8], mut pending: usize) -> io::Result<()> {
    let socket: OwnedFd = socket(
        AddressFamily::Netlink,
        SockType::Raw,
        SockFlag::SOCK_CLOEXEC,
        protocol,
    )?;
    bind(socket.as_raw_fd(), &NetlinkAddr::new(0, 0))?;
    send(socket.as_raw_fd(), request, MsgFlags::empty())?;
    let mut buffer = vec![0; 64 * 1024];
    while pending > 0 {
        let received = recv(socket.as_raw_fd(), &mut buffer, MsgFlags::empty())?;
        let mut reply = &buffer[..received];
        while reply.len() >= HEADER {
            let length = u32::from_ne_bytes(field(reply, 0)?) as usize;
            if u16::from_ne_bytes(field(reply, 4)?) == ERROR {
                let code = i32::from_ne_bytes(field(reply, HEADER)?);
                if code != 0 {
                    return Err(io::Error::from_raw_os_error(-code));
                }
                pending -= 1;
            }
            reply = reply
                .get(length.next_multiple_of(4).max(HEADER)..)
                .unwrap_or_default();
        }
    }
    Ok(())
}

fn step(what: &str, result: io::Result<()>) -> io::Result<()> {
    result.map_err(|error| io::Error::new(error.kind(), format!("{what}: {error}")))
}

pub struct Interface<'a> {
    pub address: Ipv4Addr,
    pub gateway: Ipv4Addr,
    pub mtu: u32,
    pub name: &'a str,
    pub prefix: u8,
}

pub fn configure(interface: &Interface) -> io::Result<()> {
    let index = if_nametoindex(interface.name).map_err(|error| {
        io::Error::new(
            io::Error::from(error).kind(),
            format!("find the interface {}: {error}", interface.name),
        )
    })?;
    let mut link = vec![0; 4];
    link.extend_from_slice(&index.to_ne_bytes());
    link.extend_from_slice(&LINK_UP.to_ne_bytes());
    link.extend_from_slice(&LINK_UP.to_ne_bytes());
    step(
        "bring the interface up",
        transact(
            SockProtocol::NetlinkRoute,
            &message(
                NEW_LINK,
                ACK,
                &link,
                &Attributes::default().bytes(LINK_MTU, &interface.mtu.to_ne_bytes()),
            ),
            1,
        ),
    )?;
    let mut address = vec![FAMILY_INET, interface.prefix, 0, 0];
    address.extend_from_slice(&index.to_ne_bytes());
    step(
        "assign the address",
        transact(
            SockProtocol::NetlinkRoute,
            &message(
                NEW_ADDRESS,
                ACK | CREATE | EXCLUSIVE,
                &address,
                &Attributes::default()
                    .bytes(ADDRESS_LOCAL, &interface.address.octets())
                    .bytes(ADDRESS_ADDRESS, &interface.address.octets()),
            ),
            1,
        ),
    )?;
    let route = [
        FAMILY_INET,
        0,
        0,
        0,
        ROUTE_MAIN,
        ROUTE_STATIC,
        0,
        ROUTE_UNICAST,
        0,
        0,
        0,
        0,
    ];
    step(
        "add the default route",
        transact(
            SockProtocol::NetlinkRoute,
            &message(
                NEW_ROUTE,
                ACK | CREATE | EXCLUSIVE,
                &route,
                &Attributes::default()
                    .bytes(ROUTE_GATEWAY, &interface.gateway.octets())
                    .bytes(ROUTE_INTERFACE, &index.to_ne_bytes()),
            ),
            1,
        ),
    )
}

fn expression(name: &str, data: &Attributes) -> Attributes {
    Attributes::default()
        .text(EXPRESSION_NAME, name)
        .nest(EXPRESSION_DATA, data)
}

fn accept() -> Attributes {
    expression(
        "immediate",
        &Attributes::default()
            .number(IMMEDIATE_DESTINATION, REGISTER_VERDICT)
            .nest(
                IMMEDIATE_DATA,
                &Attributes::default().nest(
                    DATA_VERDICT,
                    &Attributes::default().number(VERDICT_CODE, ACCEPT),
                ),
            ),
    )
}

fn compare(operation: u32, value: &[u8]) -> Attributes {
    expression(
        "cmp",
        &Attributes::default()
            .number(COMPARE_SOURCE, REGISTER)
            .number(COMPARE_OPERATION, operation)
            .value(COMPARE_DATA, value),
    )
}

fn load(name: &str, key: u32) -> Attributes {
    expression(
        name,
        &Attributes::default()
            .number(LOOKUP_DESTINATION, REGISTER)
            .number(LOOKUP_KEY, key),
    )
}

fn rule(expressions: impl IntoIterator<Item = Attributes>) -> Attributes {
    Attributes::default()
        .text(RULE_TABLE, TABLE)
        .text(RULE_CHAIN, CHAIN)
        .nest(
            RULE_EXPRESSIONS,
            &expressions
                .into_iter()
                .fold(Attributes::default(), |list, expression| {
                    list.nest(LIST_ELEMENT, &expression)
                }),
        )
}

pub fn firewall() -> io::Result<()> {
    let family = [FAMILY_BOTH, 0, 0, 0];
    let batch = [0, 0, 0, TABLES.to_be_bytes()[1]];
    let mut loopback = [0; INTERFACE_NAME_LENGTH];
    loopback[..LOOPBACK.len()].copy_from_slice(LOOPBACK.as_bytes());
    let known = STATE_ESTABLISHED | STATE_RELATED;
    let request = [
        message(BATCH_BEGIN, 0, &batch, &Attributes::default()),
        message(
            NEW_TABLE,
            ACK | CREATE,
            &family,
            &Attributes::default().text(TABLE_NAME, TABLE),
        ),
        message(
            NEW_CHAIN,
            ACK | CREATE,
            &family,
            &Attributes::default()
                .text(CHAIN_TABLE, TABLE)
                .text(CHAIN_NAME, CHAIN)
                .nest(
                    CHAIN_HOOK,
                    &Attributes::default()
                        .number(HOOK_NUMBER, HOOK_INPUT)
                        .number(HOOK_PRIORITY, 0),
                )
                .number(CHAIN_POLICY, DROP)
                .text(CHAIN_TYPE, "filter"),
        ),
        message(
            NEW_RULE,
            ACK | CREATE,
            &family,
            &rule([
                load("meta", META_INPUT_NAME),
                compare(COMPARE_EQUAL, &loopback),
                accept(),
            ]),
        ),
        message(
            NEW_RULE,
            ACK | CREATE,
            &family,
            &rule([
                load("ct", STATE),
                expression(
                    "bitwise",
                    &Attributes::default()
                        .number(BITWISE_SOURCE, REGISTER)
                        .number(BITWISE_DESTINATION, REGISTER)
                        .number(BITWISE_LENGTH, 4)
                        .value(BITWISE_MASK, &known.to_ne_bytes())
                        .value(BITWISE_XOR, &0_u32.to_ne_bytes()),
                ),
                compare(COMPARE_UNEQUAL, &0_u32.to_ne_bytes()),
                accept(),
            ]),
        ),
        message(BATCH_END, 0, &batch, &Attributes::default()),
    ]
    .concat();
    step(
        "drop inbound connections",
        transact(SockProtocol::NetlinkNetFilter, &request, 4),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_are_padded_to_four_bytes() {
        let attributes = Attributes::default().text(TABLE_NAME, "ab").number(2, 1);
        assert_eq!(
            attributes.0,
            [
                7_u16.to_ne_bytes().as_slice(),
                &TABLE_NAME.to_ne_bytes(),
                b"ab\0\0",
                &8_u16.to_ne_bytes(),
                &2_u16.to_ne_bytes(),
                &1_u32.to_be_bytes(),
            ]
            .concat()
        );
    }

    #[test]
    fn a_message_carries_its_length_and_the_request_flag() {
        let bytes = message(NEW_TABLE, ACK, &[1, 0, 0, 0], &Attributes::default());
        assert_eq!(bytes.len(), HEADER + 4);
        assert_eq!(u32::from_ne_bytes(field(&bytes, 0).unwrap()), 20);
        assert_eq!(u16::from_ne_bytes(field(&bytes, 4).unwrap()), NEW_TABLE);
        assert_eq!(u16::from_ne_bytes(field(&bytes, 6).unwrap()), REQUEST | ACK);
    }
}

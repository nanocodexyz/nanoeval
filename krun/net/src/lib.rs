#[macro_export]
macro_rules! eprintln {
    ($($argument:tt)*) => {
        let _ = std::io::Write::write_all(
            &mut std::io::stderr(),
            format!("{}
", format_args!($($argument)*)).as_bytes(),
        );
    };
}

pub mod forward;
pub mod netlink;

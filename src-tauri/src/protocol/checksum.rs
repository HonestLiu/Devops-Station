//! Frame checksum algorithms for the Protocol Designer.
//!
//! Implemented by hand (no external `crc` crate) to avoid an extra dependency
//! and keep the offline build hermetic. All functions take the exact byte
//! range to be checksummed.

use crate::protocol::types::ChecksumAlgo;

/// 8-bit 累加和 (sum of bytes, mod 256).
pub fn sum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |acc, b| acc.wrapping_add(*b))
}

/// 逐字节 XOR.
pub fn xor(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |acc, b| acc ^ *b)
}

/// CRC-8 (poly 0x07, init 0x00, no reflection).
pub fn crc8(bytes: &[u8]) -> u8 {
    let mut crc: u8 = 0x00;
    for &b in bytes {
        crc ^= b;
        for _ in 0..8 {
            if crc & 0x80 != 0 {
                crc = (crc << 1) ^ 0x07;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// Reflect a `width`-bit integer (used by reflected CRCs).
fn reflect(value: u32, width: u32) -> u32 {
    let mut result = 0u32;
    for i in 0..width {
        if value & (1 << i) != 0 {
            result |= 1 << (width - 1 - i);
        }
    }
    result
}

/// CRC-16/MODBUS (poly 0x8005, init 0xFFFF, refin & refout = true, xorout 0x0000).
pub fn crc16_modbus(bytes: &[u8]) -> u16 {
    const POLY: u16 = 0x8005;
    let mut crc: u16 = 0xFFFF;
    for &b in bytes {
        let b = reflect(b as u32, 8) as u8;
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ POLY;
            } else {
                crc <<= 1;
            }
        }
    }
    reflect(crc as u32, 16) as u16
}

/// CRC-32 (poly 0x04C11DB7, init 0xFFFFFFFF, refin & refout = true, xorout 0xFFFFFFFF).
pub fn crc32(bytes: &[u8]) -> u32 {
    const POLY: u32 = 0x04C11DB7;
    let mut crc: u32 = 0xFFFFFFFF;
    for &b in bytes {
        let b = reflect(b as u32, 8);
        crc ^= b << 24;
        for _ in 0..8 {
            if crc & 0x8000_0000 != 0 {
                crc = (crc << 1) ^ POLY;
            } else {
                crc <<= 1;
            }
        }
    }
    !reflect(crc, 32)
}

/// Compute the checksum over `range` using `algo`. Returns `None` for `None`.
pub fn compute(algo: ChecksumAlgo, range: &[u8]) -> Option<u64> {
    match algo {
        ChecksumAlgo::None => None,
        ChecksumAlgo::Sum => Some(sum(range) as u64),
        ChecksumAlgo::Xor => Some(xor(range) as u64),
        ChecksumAlgo::Crc8 => Some(crc8(range) as u64),
        ChecksumAlgo::Crc16Modbus => Some(crc16_modbus(range) as u64),
        ChecksumAlgo::Crc32 => Some(crc32(range) as u64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc16_modbus_known_vector() {
        // "123456789" → 0x4B37.
        assert_eq!(crc16_modbus(b"123456789"), 0x4B37);
    }

    #[test]
    fn crc32_known_vector() {
        // "123456789" → 0xCBF43926.
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn sum_and_xor() {
        assert_eq!(sum(&[0x01, 0x02, 0xFF]), 0x02);
        assert_eq!(xor(&[0x01, 0x02, 0x03]), 0x00);
    }
}
